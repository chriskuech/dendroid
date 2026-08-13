// The main-area surface for a SQLite database — what replaces the Editor
// once one is selected in the sidebar's Databases tab (see Workspace.tsx's
// `selectedDatabaseId`). A basic table UI: a strip of tables, a paginated
// data grid with inline cell editing/row add/row delete, a form for
// creating a new table, and a "Run SQL" console for anything the grid
// can't express (ALTER TABLE, a JOIN, ...). Every mutation goes through
// `lib/db.ts`'s `execSql`, which ledgers it — see
// `dendroid_core::sqldb::SqlWorkspace::exec`.
//
// Deliberately "basic": rows are addressed by SQLite's own implicit
// `rowid` (see `TableRowDto`), which a `WITHOUT ROWID` table doesn't have
// — such a table is browsable here (it shows up in the table strip and
// its rows render) but not editable through the grid, same limitation
// most basic spreadsheet-style table UIs accept.

import { useCallback, useEffect, useMemo, useState } from "react";
import { DatabaseIcon, IncrementIcon, TrashIcon } from "../icons";
import { Button } from "../ui/Button";
import {
  execSql,
  listTables,
  onDatabasesChanged,
  tableRows,
  type ColumnDto,
  type DatabaseDto,
  type TableDto,
  type TableRowsDto,
} from "../../lib/db";
import "../../styles/database.css";

interface DatabaseViewProps {
  database: DatabaseDto;
  /** Returns to the Editor — clears `Workspace.tsx`'s `selectedDatabaseId`. */
  onClose: () => void;
}

const PAGE_SIZE = 50;
const SQL_TYPES = ["TEXT", "INTEGER", "REAL", "BLOB"];

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Renders one cell's value for display (not while it's being edited) —
 * `null` reads as a muted "NULL" rather than blank, so an empty string and
 * a genuine SQL NULL never look the same. */
function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="db-cell__null">NULL</span>;
  return <>{String(value)}</>;
}

export function DatabaseView({ database, onClose }: DatabaseViewProps) {
  const [tables, setTables] = useState<TableDto[] | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [rows, setRows] = useState<TableRowsDto | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ rowid: number; column: string } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [newTableOpen, setNewTableOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleText, setConsoleText] = useState("");
  const [consoleRunning, setConsoleRunning] = useState(false);

  const refreshTables = useCallback(() => {
    listTables(database.id)
      .then((list) => {
        setTables(list);
        setError(null);
        setSelectedTable((current) => {
          if (current && list.some((t) => t.name === current)) return current;
          return list[0]?.name ?? null;
        });
      })
      .catch((err: unknown) => setError(String(err)));
  }, [database.id]);

  const refreshRows = useCallback(() => {
    if (!selectedTable) {
      setRows(null);
      return;
    }
    tableRows(database.id, selectedTable, PAGE_SIZE, offset)
      .then((result) => {
        setRows(result);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)));
  }, [database.id, selectedTable, offset]);

  useEffect(() => {
    setTables(null);
    setSelectedTable(null);
    setOffset(0);
    refreshTables();
  }, [database.id, refreshTables]);

  useEffect(() => {
    setOffset(0);
  }, [selectedTable]);

  useEffect(() => {
    refreshRows();
  }, [refreshRows]);

  useEffect(() => onDatabasesChanged(() => {
    refreshTables();
    refreshRows();
  }), [refreshTables, refreshRows]);

  const runExec = useCallback(
    (sql: string, params: unknown[] = [], batch = false) =>
      execSql(database.id, sql, params, batch)
        .then(() => setError(null))
        .catch((err: unknown) => {
          setError(String(err));
          throw err;
        }),
    [database.id],
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

  const runConsole = useCallback(() => {
    const sql = consoleText.trim();
    if (!sql || consoleRunning) return;
    setConsoleRunning(true);
    runExec(sql, [], true)
      .then(() => {
        setConsoleText("");
        refreshTables();
        refreshRows();
      })
      .catch(() => {})
      .finally(() => setConsoleRunning(false));
  }, [consoleText, consoleRunning, runExec, refreshTables, refreshRows]);

  const pageStart = rows && rows.totalRows > 0 ? offset + 1 : 0;
  const pageEnd = rows ? Math.min(offset + rows.rows.length, rows.totalRows) : 0;

  return (
    <div className="db-view">
      <div className="db-view__header">
        <DatabaseIcon size={16} />
        <span className="db-view__title">{database.name}</span>
        <div className="db-view__header-spacer" />
        <Button variant="quiet" onClick={() => setConsoleOpen((v) => !v)}>
          {consoleOpen ? "Hide SQL" : "Run SQL"}
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
          <textarea
            className="db-view__console-input"
            value={consoleText}
            onChange={(e) => setConsoleText(e.target.value)}
            placeholder="Any SQL — multiple statements separated by ';' are all run."
            rows={4}
          />
          <div className="db-view__console-footer">
            <Button variant="primary" disabled={!consoleText.trim() || consoleRunning} onClick={runConsole}>
              {consoleRunning ? "Running…" : "Run"}
            </Button>
          </div>
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
                      <ColumnHeader column={col} />
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
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") e.currentTarget.blur();
                                if (e.key === "Escape") setEditing(null);
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

function ColumnHeader({ column }: { column: ColumnDto }) {
  return (
    <span className="db-view__col-header">
      <span className="db-view__col-name">{column.name}</span>
      <span className="db-view__col-type">
        {column.sqlType || "ANY"}
        {column.primaryKey ? " · PK" : ""}
        {column.notNull ? " · NOT NULL" : ""}
      </span>
    </span>
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
