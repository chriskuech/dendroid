// The main-area surface for a SQLite database — what replaces the Editor
// once one is selected in the sidebar's Databases tab (see Workspace.tsx's
// `selectedDatabaseId`). A full-featured table UI: a strip of tables, a
// paginated, sortable data grid with inline cell editing (keyboard-
// navigable, spreadsheet-style) and row add/delete, a form for creating a
// new table, and a SQL editor — complete with table/column-name typeahead —
// for anything the grid can't express (a `SELECT` with a `JOIN`, an `ALTER
// TABLE`, ...). Every mutation goes through `adapters/db`'s `execSql`, which
// ledgers it — see `dendroid_core::sqldb::SqlWorkspace::exec`. A read-only
// statement typed into the SQL editor instead goes through `queryDb`, which
// never touches the ledger — see `SqlWorkspace::query`.
//
// Deliberately "basic" beyond that: rows are addressed by SQLite's own
// implicit `rowid` (see `TableRowDto`), which a `WITHOUT ROWID` table
// doesn't have — such a table is browsable here (it shows up in the table
// strip and its rows render) but not editable through the grid, same
// limitation most basic spreadsheet-style table UIs accept.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DatabaseIcon, IncrementIcon, TrashIcon } from "../../ui/icons";
import { Button } from "../../ui/Button";
import { getCaretCoordinates } from "./caretCoords";
import { useDb } from "../../adapters/db/context";
import type { ColumnDto, DatabaseDto, QueryResultDto, TableDto, TableRowsDto } from "../../adapters/db";
import "./database.css";

interface DatabaseViewProps {
  database: DatabaseDto;
  /** Returns to the Editor — clears `Workspace.tsx`'s `selectedDatabaseId`. */
  onClose: () => void;
}

const PAGE_SIZE = 50;
const SQL_TYPES = ["TEXT", "INTEGER", "REAL", "BLOB"];

/** Keywords offered alongside table/column names in the SQL editor's
 * typeahead — not exhaustive, just the ones common enough in ad hoc
 * queries against a small workspace database to be worth completing. */
const SQL_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "INSERT INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE FROM",
  "CREATE TABLE",
  "ALTER TABLE",
  "DROP TABLE",
  "JOIN",
  "LEFT JOIN",
  "INNER JOIN",
  "ON",
  "GROUP BY",
  "ORDER BY",
  "LIMIT",
  "OFFSET",
  "AND",
  "OR",
  "NOT",
  "NULL",
  "DISTINCT",
  "AS",
  "IN",
  "LIKE",
  "BETWEEN",
  "HAVING",
  "UNION",
  "PRAGMA",
];

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Whether `sql` (as typed into the SQL editor) looks like a single
 * read-only statement worth running through `queryDb` for a live result
 * grid, rather than `execSql`'s ledgered exec path. A pragmatic heuristic,
 * not a parser: `queryDb`/`SqlWorkspace::query` is the actual authority
 * (it rejects anything that isn't really read-only via SQLite's own
 * `sqlite3_stmt_readonly`) — this just decides which path to try first, so
 * a false positive here still fails safely rather than silently bypassing
 * the ledger. A multi-statement script (more than one `;`-separated
 * statement) always goes through `execSql`'s batch path instead, since
 * `queryDb` only runs one statement. */
function looksReadOnly(sql: string): boolean {
  const withoutTrailingSemicolon = sql.trim().replace(/;\s*$/, "");
  if (withoutTrailingSemicolon.includes(";")) return false;
  return /^(select|pragma|explain)\b/i.test(withoutTrailingSemicolon);
}

interface Suggestion {
  items: string[];
  /** Character offsets in the textarea's text that the chosen suggestion
   * replaces — the identifier fragment currently being typed. */
  start: number;
  end: number;
  activeIndex: number;
  /** Anchor position, relative to the textarea's own top-left corner and
   * already adjusted for its current scroll offset. */
  top: number;
  left: number;
}

/** Finds the identifier fragment ending at `caret` (e.g. the `us` in
 * `SELECT * FROM us|` while typing `users`) and, if there's one, the set of
 * table/column/keyword names it could complete to. Returns `null` when the
 * caret isn't inside an identifier-like word, or nothing matches. A `.`
 * right before the fragment (`t.na|`) narrows suggestions to the columns of
 * the table named before the dot — the SQL editor's one bit of
 * "understands the query" smarts; anywhere else, both table and column
 * names (plus keywords) are all offered together rather than trying to
 * actually parse the statement. */
function computeSuggestions(text: string, caret: number, tables: TableDto[]): { items: string[]; start: number; end: number } | null {
  const before = text.slice(0, caret);
  const match = /([A-Za-z_][A-Za-z0-9_]*)(\.([A-Za-z0-9_]*))?$/.exec(before);
  if (!match) return null;

  const dotted = match[2] !== undefined;
  const word = (dotted ? match[3] : match[1]) ?? "";
  if (!word) return null;

  let candidates: string[];
  if (dotted) {
    const tableName = match[1];
    const table = tables.find((t) => t.name.toLowerCase() === tableName.toLowerCase());
    candidates = table ? table.columns.map((c) => c.name) : tables.flatMap((t) => t.columns.map((c) => c.name));
  } else {
    const tableNames = tables.map((t) => t.name);
    const columnNames = tables.flatMap((t) => t.columns.map((c) => c.name));
    candidates = [...tableNames, ...columnNames, ...SQL_KEYWORDS];
  }

  const lower = word.toLowerCase();
  const matches = candidates.filter((c) => c.toLowerCase().startsWith(lower) && c.toLowerCase() !== lower);
  const items = Array.from(new Set(matches)).slice(0, 8);
  if (items.length === 0) return null;

  return { items, start: caret - word.length, end: caret };
}

/** Renders one cell's value for display (not while it's being edited) —
 * `null` reads as a muted "NULL" rather than blank, so an empty string and
 * a genuine SQL NULL never look the same. */
function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="db-cell__null">NULL</span>;
  return <>{String(value)}</>;
}

export function DatabaseView({ database, onClose }: DatabaseViewProps) {
  const db = useDb();
  const [tables, setTables] = useState<TableDto[] | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [rows, setRows] = useState<TableRowsDto | null>(null);
  const [offset, setOffset] = useState(0);
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDesc, setSortDesc] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ rowid: number; column: string } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [newTableOpen, setNewTableOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleText, setConsoleText] = useState("");
  const [consoleRunning, setConsoleRunning] = useState(false);
  const [queryResult, setQueryResult] = useState<QueryResultDto | null>(null);
  const [suggest, setSuggest] = useState<Suggestion | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** Set by the edit input's Enter/Tab handler just before it blurs itself
   * (to commit — see that handler's comment), read and cleared by the
   * resulting `onBlur` once the commit is in flight. */
  const pendingMove = useRef<{ dRow: number; dCol: number } | null>(null);

  const refreshTables = useCallback(() => {
    db.listTables(database.id)
      .then((list) => {
        setTables(list);
        setError(null);
        setSelectedTable((current) => {
          if (current && list.some((t) => t.name === current)) return current;
          return list[0]?.name ?? null;
        });
      })
      .catch((err: unknown) => setError(String(err)));
  }, [database.id, db]);

  const refreshRows = useCallback(() => {
    if (!selectedTable) {
      setRows(null);
      return;
    }
    db.tableRows(database.id, selectedTable, PAGE_SIZE, offset, sortColumn, sortDesc)
      .then((result) => {
        setRows(result);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)));
  }, [database.id, selectedTable, offset, sortColumn, sortDesc, db]);

  useEffect(() => {
    setTables(null);
    setSelectedTable(null);
    setOffset(0);
    refreshTables();
  }, [database.id, refreshTables]);

  useEffect(() => {
    setOffset(0);
    setSortColumn(null);
    setSortDesc(false);
    setEditing(null);
  }, [selectedTable]);

  useEffect(() => {
    refreshRows();
  }, [refreshRows]);

  useEffect(
    () =>
      db.onDatabasesChanged(() => {
        refreshTables();
        refreshRows();
      }),
    [refreshTables, refreshRows, db],
  );

  const runExec = useCallback(
    (sql: string, params: unknown[] = [], batch = false) =>
      db
        .execSql(database.id, sql, params, batch)
        .then(() => setError(null))
        .catch((err: unknown) => {
          setError(String(err));
          throw err;
        }),
    [database.id, db],
  );

  /** Toggles `column`'s sort state through the usual three-way cycle —
   * ascending, descending, back to the table's natural `rowid` order —
   * same as clicking a spreadsheet column header. Paging resets to the
   * first page, since "row 51 under the old order" is a different row
   * once the sort changes. */
  const toggleSort = useCallback(
    (column: string) => {
      setOffset(0);
      if (sortColumn !== column) {
        setSortColumn(column);
        setSortDesc(false);
      } else if (!sortDesc) {
        setSortDesc(true);
      } else {
        setSortColumn(null);
        setSortDesc(false);
      }
    },
    [sortColumn, sortDesc],
  );

  const commitEdit = useCallback(
    (rowid: number, column: string, value: string) => {
      if (!selectedTable) return;
      const param = value.trim() === "" ? null : value;
      runExec(`UPDATE ${quoteIdent(selectedTable)} SET ${quoteIdent(column)} = ?1 WHERE rowid = ?2`, [param, rowid])
        .then(refreshRows)
        .catch(() => {});
    },
    [selectedTable, runExec, refreshRows],
  );

  /** Moves the in-progress edit `dRow`/`dCol` cells away from `(fromRowid,
   * fromColumn)` and opens the target cell for editing — what Tab/Shift+Tab
   * (across, wrapping to the next/previous row) and Enter (down) do from
   * the edit input's `onBlur`. A no-op past either edge of the currently
   * loaded page, rather than paging or wrapping around — simple beats
   * clever here, and the common case (Tab-ing across a row, Enter-ing down
   * a column) never hits it. */
  const moveEdit = useCallback(
    (fromRowid: number, fromColumn: string, dRow: number, dCol: number) => {
      if (!rows) return;
      const rowIdx = rows.rows.findIndex((r) => r.rowid === fromRowid);
      const colIdx = rows.columns.findIndex((c) => c.name === fromColumn);
      if (rowIdx === -1 || colIdx === -1) return;

      let newRow = rowIdx + dRow;
      let newCol = colIdx + dCol;
      if (newCol >= rows.columns.length) {
        newCol = 0;
        newRow += 1;
      } else if (newCol < 0) {
        newCol = rows.columns.length - 1;
        newRow -= 1;
      }
      if (newRow < 0 || newRow >= rows.rows.length) return;

      const targetRow = rows.rows[newRow];
      const targetCol = rows.columns[newCol];
      const value = targetRow.values[newCol];
      setEditing({ rowid: targetRow.rowid, column: targetCol.name });
      setEditValue(value === null || value === undefined ? "" : String(value));
    },
    [rows],
  );

  const addRow = useCallback(() => {
    if (!selectedTable) return;
    runExec(`INSERT INTO ${quoteIdent(selectedTable)} DEFAULT VALUES`)
      .then(refreshRows)
      .catch(() => {});
  }, [selectedTable, runExec, refreshRows]);

  const deleteRow = useCallback(
    (rowid: number) => {
      if (!selectedTable) return;
      runExec(`DELETE FROM ${quoteIdent(selectedTable)} WHERE rowid = ?1`, [rowid])
        .then(refreshRows)
        .catch(() => {});
    },
    [selectedTable, runExec, refreshRows],
  );

  const updateSuggestions = useCallback(
    (text: string, caret: number) => {
      const el = textareaRef.current;
      if (!el) {
        setSuggest(null);
        return;
      }
      const computed = computeSuggestions(text, caret, tables ?? []);
      if (!computed) {
        setSuggest(null);
        return;
      }
      const coords = getCaretCoordinates(el, caret);
      setSuggest({
        items: computed.items,
        start: computed.start,
        end: computed.end,
        activeIndex: 0,
        top: coords.top + coords.height - el.scrollTop,
        left: coords.left - el.scrollLeft,
      });
    },
    [tables],
  );

  const applySuggestion = useCallback(
    (word: string) => {
      if (!suggest) return;
      const next = consoleText.slice(0, suggest.start) + word + consoleText.slice(suggest.end);
      setConsoleText(next);
      setSuggest(null);
      const pos = suggest.start + word.length;
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(pos, pos);
      });
    },
    [suggest, consoleText],
  );

  const runConsole = useCallback(() => {
    const sql = consoleText.trim();
    if (!sql || consoleRunning) return;
    setConsoleRunning(true);
    setError(null);

    if (looksReadOnly(sql)) {
      db.queryDb(database.id, sql.replace(/;\s*$/, ""))
        .then((result) => {
          setQueryResult(result);
          setError(null);
        })
        .catch((err: unknown) => {
          setQueryResult(null);
          setError(String(err));
        })
        .finally(() => setConsoleRunning(false));
      return;
    }

    setQueryResult(null);
    runExec(sql, [], true)
      .then(() => {
        setConsoleText("");
        refreshTables();
        refreshRows();
      })
      .catch(() => {})
      .finally(() => setConsoleRunning(false));
  }, [consoleText, consoleRunning, database.id, runExec, refreshTables, refreshRows, db]);

  const handleConsoleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (suggest) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSuggest({ ...suggest, activeIndex: (suggest.activeIndex + 1) % suggest.items.length });
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSuggest({ ...suggest, activeIndex: (suggest.activeIndex - 1 + suggest.items.length) % suggest.items.length });
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          applySuggestion(suggest.items[suggest.activeIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSuggest(null);
          return;
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        runConsole();
      }
    },
    [suggest, applySuggestion, runConsole],
  );

  const handleConsoleCaretMove = useCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
      const el = e.currentTarget;
      updateSuggestions(el.value, el.selectionStart ?? el.value.length);
    },
    [updateSuggestions],
  );

  const pageStart = rows && rows.totalRows > 0 ? offset + 1 : 0;
  const pageEnd = rows ? Math.min(offset + rows.rows.length, rows.totalRows) : 0;

  return (
    <div className="db-view">
      <div className="db-view__header">
        <DatabaseIcon size={16} />
        <span className="db-view__title">{database.name}</span>
        <div className="db-view__header-spacer" />
        <Button
          variant="quiet"
          onClick={() => {
            setConsoleOpen((v) => !v);
            setSuggest(null);
          }}
        >
          {consoleOpen ? "Hide SQL Editor" : "SQL Editor"}
        </Button>
        <Button variant="quiet" onClick={onClose}>
          Back to notes
        </Button>
      </div>

      <div className="db-view__tables">
        {(tables ?? []).map((t) => (
          <button
            key={t.name}
            type="button"
            className={`db-view__tab${t.name === selectedTable ? " is-active" : ""}`}
            onClick={() => setSelectedTable(t.name)}
          >
            {t.name}
          </button>
        ))}
        <button type="button" className="db-view__tab db-view__tab--new" onClick={() => setNewTableOpen((v) => !v)}>
          <IncrementIcon size={11} /> New table
        </button>
      </div>

      {newTableOpen && (
        <NewTableForm
          onCancel={() => setNewTableOpen(false)}
          onCreate={(sql, tableName) => {
            runExec(sql)
              .then(() => {
                setNewTableOpen(false);
                setSelectedTable(tableName);
                refreshTables();
              })
              .catch(() => {});
          }}
        />
      )}

      {consoleOpen && (
        <div className="db-view__console">
          <div className="db-view__console-editor">
            <textarea
              ref={textareaRef}
              className="db-view__console-input"
              value={consoleText}
              onChange={(e) => {
                setConsoleText(e.target.value);
                updateSuggestions(e.target.value, e.target.selectionStart ?? e.target.value.length);
              }}
              onKeyDown={handleConsoleKeyDown}
              onClick={handleConsoleCaretMove}
              onKeyUp={(e) => {
                if (["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) return;
                handleConsoleCaretMove(e);
              }}
              onBlur={() => setSuggest(null)}
              onScroll={() => setSuggest(null)}
              placeholder="A SELECT to preview results, or any other SQL — multiple statements separated by ';' are all run and ledgered."
              rows={4}
              spellCheck={false}
            />
            {suggest && (
              <ul className="db-view__typeahead" style={{ top: suggest.top, left: suggest.left }}>
                {suggest.items.map((item, i) => (
                  <li
                    key={item}
                    className={`db-view__typeahead-item${i === suggest.activeIndex ? " is-active" : ""}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setSuggest({ ...suggest, activeIndex: i })}
                    onClick={() => applySuggestion(item)}
                  >
                    {item}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="db-view__console-footer">
            <span className="db-view__console-hint">⌘/Ctrl + Enter to run</span>
            <Button variant="primary" disabled={!consoleText.trim() || consoleRunning} onClick={runConsole}>
              {consoleRunning ? "Running…" : "Run"}
            </Button>
          </div>
          {queryResult && <QueryResultGrid result={queryResult} />}
        </div>
      )}

      {error && <div className="db-view__error">{error}</div>}

      {tables && tables.length === 0 && !newTableOpen ? (
        <div className="db-view__empty">No tables yet — create one, or run SQL above.</div>
      ) : selectedTable && rows ? (
        <>
          <div className="db-view__grid-wrap">
            <table className="db-view__grid">
              <thead>
                <tr>
                  {rows.columns.map((col) => (
                    <th key={col.name}>
                      <ColumnHeader
                        column={col}
                        sortDir={sortColumn === col.name ? (sortDesc ? "desc" : "asc") : null}
                        onSort={() => toggleSort(col.name)}
                      />
                    </th>
                  ))}
                  <th className="db-view__grid-actions-col" />
                </tr>
              </thead>
              <tbody>
                {rows.rows.map((row) => (
                  <tr key={row.rowid}>
                    {rows.columns.map((col, i) => {
                      const isEditing = editing?.rowid === row.rowid && editing.column === col.name;
                      return (
                        <td
                          key={col.name}
                          className="db-cell"
                          onClick={() => {
                            if (isEditing) return;
                            setEditing({ rowid: row.rowid, column: col.name });
                            const v = row.values[i];
                            setEditValue(v === null || v === undefined ? "" : String(v));
                          }}
                        >
                          {isEditing ? (
                            <input
                              autoFocus
                              className="db-cell__input"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onBlur={() => {
                                commitEdit(row.rowid, col.name, editValue);
                                setEditing(null);
                                const pending = pendingMove.current;
                                pendingMove.current = null;
                                if (pending) moveEdit(row.rowid, col.name, pending.dRow, pending.dCol);
                              }}
                              onKeyDown={(e) => {
                                // Enter/Tab commit via the natural `onBlur`
                                // below (triggered by `.blur()`), then move
                                // once the commit is in flight — a single
                                // commit path avoids double-committing from
                                // both the keydown and the blur that
                                // removing this input from the DOM would
                                // otherwise also fire.
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  pendingMove.current = { dRow: 1, dCol: 0 };
                                  e.currentTarget.blur();
                                } else if (e.key === "Tab") {
                                  e.preventDefault();
                                  pendingMove.current = { dRow: 0, dCol: e.shiftKey ? -1 : 1 };
                                  e.currentTarget.blur();
                                } else if (e.key === "Escape") {
                                  pendingMove.current = null;
                                  setEditing(null);
                                }
                              }}
                            />
                          ) : (
                            <CellValue value={row.values[i]} />
                          )}
                        </td>
                      );
                    })}
                    <td className="db-view__grid-actions-col">
                      <span className="db-view__row-delete" title="Delete row" onClick={() => deleteRow(row.rowid)}>
                        <TrashIcon size={11} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="db-view__footer">
            <button type="button" className="db-view__add-row" onClick={addRow}>
              <IncrementIcon size={11} /> Add row
            </button>
            <div className="db-view__footer-spacer" />
            <span className="db-view__page-info">
              {rows.totalRows === 0 ? "0 rows" : `${pageStart}–${pageEnd} of ${rows.totalRows}`}
            </span>
            <button type="button" className="db-view__page-btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
              Prev
            </button>
            <button
              type="button"
              className="db-view__page-btn"
              disabled={pageEnd >= rows.totalRows}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Sort/type/PK header for one grid column — clicking anywhere on it cycles
 * `onSort` through ascending → descending → unsorted (see `toggleSort`),
 * with `sortDir` driving the ▲/▼ indicator so the currently-active sort is
 * visible without having to remember what was last clicked. */
function ColumnHeader({ column, sortDir, onSort }: { column: ColumnDto; sortDir: "asc" | "desc" | null; onSort: () => void }) {
  return (
    <button type="button" className="db-view__col-header" onClick={onSort}>
      <span className="db-view__col-name">
        <span className="db-view__col-name-text">{column.name}</span>
        <span className={`db-view__col-sort${sortDir ? " is-active" : ""}`}>{sortDir === "desc" ? "▼" : "▲"}</span>
      </span>
      <span className="db-view__col-type">
        {column.sqlType || "ANY"}
        {column.primaryKey ? " · PK" : ""}
        {column.notNull ? " · NOT NULL" : ""}
      </span>
    </button>
  );
}

/** Read-only result grid for a `SELECT` (or `PRAGMA`/`EXPLAIN`) run through
 * the SQL editor — deliberately separate from the main table grid above:
 * an arbitrary query's columns aren't addressable by `rowid` (it may not
 * even name a single table), so there's no editing here, just a sortable
 * view of whatever came back. Sorting is client-side, unlike the table
 * grid's server-side `ORDER BY` — the whole result set is already in
 * memory (a query editor result isn't paginated), so there's nothing to
 * gain by round-tripping. */
function QueryResultGrid({ result }: { result: QueryResultDto }) {
  const [sort, setSort] = useState<{ col: number; desc: boolean } | null>(null);

  const sortedRows = useMemo(() => {
    if (!sort) return result.rows;
    const { col, desc } = sort;
    const withIndex = result.rows.map((r, i) => [r, i] as const);
    withIndex.sort(([a, ai], [b, bi]) => {
      const av = a[col];
      const bv = b[col];
      let cmp: number;
      if (av === bv) cmp = 0;
      else if (av === null || av === undefined) cmp = -1;
      else if (bv === null || bv === undefined) cmp = 1;
      else if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv));
      if (cmp === 0) cmp = ai - bi;
      return desc ? -cmp : cmp;
    });
    return withIndex.map(([r]) => r);
  }, [result.rows, sort]);

  const toggle = (col: number) => {
    setSort((current) => {
      if (!current || current.col !== col) return { col, desc: false };
      if (!current.desc) return { col, desc: true };
      return null;
    });
  };

  return (
    <div className="db-view__query-result">
      <div className="db-view__query-result-info">
        {result.rows.length === 0 ? "0 rows" : `${result.rows.length} row${result.rows.length === 1 ? "" : "s"}`}
      </div>
      <div className="db-view__grid-wrap db-view__grid-wrap--query">
        <table className="db-view__grid">
          <thead>
            <tr>
              {result.columns.map((name, i) => {
                const dir = sort?.col === i ? (sort.desc ? "desc" : "asc") : null;
                return (
                  <th key={`${name}-${i}`}>
                    <button type="button" className="db-view__col-header db-view__col-header--query" onClick={() => toggle(i)}>
                      <span className="db-view__col-name">
                        <span className="db-view__col-name-text">{name}</span>
                        <span className={`db-view__col-sort${dir ? " is-active" : ""}`}>{dir === "desc" ? "▼" : "▲"}</span>
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, i) => (
              <tr key={i}>
                {row.map((value, j) => (
                  <td key={j} className="db-cell">
                    <CellValue value={value} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface NewColumn {
  name: string;
  sqlType: string;
  notNull: boolean;
  primaryKey: boolean;
}

function emptyColumn(): NewColumn {
  return { name: "", sqlType: "TEXT", notNull: false, primaryKey: false };
}

function NewTableForm({ onCancel, onCreate }: { onCancel: () => void; onCreate: (sql: string, tableName: string) => void }) {
  const [name, setName] = useState("");
  const [columns, setColumns] = useState<NewColumn[]>([emptyColumn()]);

  const sql = useMemo(() => {
    const tableName = name.trim();
    const colDefs = columns
      .filter((c) => c.name.trim())
      .map((c) => `${quoteIdent(c.name.trim())} ${c.sqlType}${c.notNull ? " NOT NULL" : ""}${c.primaryKey ? " PRIMARY KEY" : ""}`);
    if (!tableName || colDefs.length === 0) return null;
    return `CREATE TABLE ${quoteIdent(tableName)} (${colDefs.join(", ")})`;
  }, [name, columns]);

  return (
    <div className="db-view__new-table">
      <input className="db-view__new-table-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Table name" autoFocus />
      <div className="db-view__new-table-cols">
        {columns.map((col, i) => (
          <div className="db-view__new-table-col" key={i}>
            <input
              className="db-view__new-table-col-name"
              value={col.name}
              onChange={(e) => setColumns(columns.map((c, j) => (j === i ? { ...c, name: e.target.value } : c)))}
              placeholder="column"
            />
            <select
              className="db-view__new-table-col-type"
              value={col.sqlType}
              onChange={(e) => setColumns(columns.map((c, j) => (j === i ? { ...c, sqlType: e.target.value } : c)))}
            >
              {SQL_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <label className="db-view__new-table-col-flag">
              <input
                type="checkbox"
                checked={col.notNull}
                onChange={(e) => setColumns(columns.map((c, j) => (j === i ? { ...c, notNull: e.target.checked } : c)))}
              />
              NOT NULL
            </label>
            <label className="db-view__new-table-col-flag">
              <input
                type="checkbox"
                checked={col.primaryKey}
                onChange={(e) => setColumns(columns.map((c, j) => (j === i ? { ...c, primaryKey: e.target.checked } : c)))}
              />
              PK
            </label>
            <span
              className="db-view__new-table-col-remove"
              onClick={() => setColumns(columns.length > 1 ? columns.filter((_, j) => j !== i) : columns)}
            >
              <TrashIcon size={11} />
            </span>
          </div>
        ))}
        <button type="button" className="db-view__new-table-add-col" onClick={() => setColumns([...columns, emptyColumn()])}>
          <IncrementIcon size={10} /> Add column
        </button>
      </div>
      <div className="db-view__new-table-footer">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!sql} onClick={() => sql && onCreate(sql, name.trim())}>
          Create table
        </Button>
      </div>
    </div>
  );
}
