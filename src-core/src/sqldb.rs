//! SQLite databases — a second, independently-ledgered store that lives
//! alongside the markdown tree (`doc`/`ledger`), reusing the exact same
//! append/tail machinery (`ledger::LedgerWriter`/`LedgerCursor`, generic
//! over the payload since this module exists) but pointed at its own
//! subdirectory (`db-ledger/`, see `native::NativeLedgerStorage::
//! for_databases`) so a `DbEvent` line never lands in the same file a
//! `LoroUpdate` line does.
//!
//! Native-only (`cfg(not(target_arch = "wasm32"))`, see `lib.rs`): unlike
//! `loro`, `rusqlite`'s `bundled` feature compiles SQLite's C source, which
//! needs a C toolchain the wasm32 target doesn't have. A workspace's
//! `db-ledger/` files are still perfectly readable by the web build's own
//! ledger machinery in principle — it just doesn't build a `SqlWorkspace`
//! to replay them into today, so a browser session simply doesn't show
//! databases yet rather than choking on lines it doesn't understand.
//!
//! # Why this isn't a CRDT
//!
//! The markdown tree is one Loro document — every replica's edits merge
//! automatically, and `history::revert_to` works by computing a diff and
//! applying it as a new op. SQLite has neither property: two replicas that
//! ran conflicting statements can't be merged into one consistent
//! database, and there's no generic "diff" between two arbitrary schemas/
//! datasets to apply as a rollback.
//!
//! What this module does instead:
//!
//! - **Ordering**: every replica replays the same set of `db-ledger/`
//!   files in the same defined order (file name, then line — the same
//!   order `ledger::LedgerCursor::poll` already uses for the markdown
//!   tree), so every replica that has seen the same files converges on
//!   the same database state. That's not distributed conflict
//!   resolution — two sessions racing to edit the same row can still
//!   produce a "last writer in replay order wins" outcome — but it's a
//!   deterministic, well-defined outcome, which is what a local,
//!   single-workspace app needs far more often than true CRDT merge.
//! - **History/revert**: each database keeps its own ordered list of
//!   `Exec` statements (`DbHandle::execs`) — the "timeline". Reverting
//!   doesn't rewrite that list; it appends a `DbEvent::Revert` marker
//!   (ledgered exactly like a `Create`/`Exec`), and every replica that
//!   replays it truncates its own live `timeline` back to the target
//!   statement and rebuilds the database from just that prefix. A later
//!   `Exec` still extends the (now-shorter) timeline — so, same as
//!   `history::revert_to`, a revert is itself just one more forward log
//!   entry every replica converges on, and nothing is ever erased from
//!   the log.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use crate::error::{DendroidError, Result};
use crate::ledger::{LedgerCursor, LedgerWriter};
use crate::storage::LedgerStorage;

/// One line of a database ledger file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum DbEvent {
    /// A new, empty database. `db` is a fresh id (a uuid, minted by
    /// `SqlWorkspace::create_database`) — the addressable unit every other
    /// event refers back to, the same role a heading's `id` plays for the
    /// markdown tree.
    Create { db: String, name: String },
    /// Removes `db` from the live set. Not a real tombstone with revert
    /// support of its own — there's no UI need for "undelete a database"
    /// today (unlike a heading delete, which `links::reconcile_backlinks`
    /// has to handle automatically because it can happen as a side effect
    /// of an ordinary edit; deleting a database is always a deliberate,
    /// one-off user action).
    Delete { db: String },
    /// One SQL statement against `db`, logged verbatim — there's no
    /// before/after diff computed anywhere in this module (unlike the
    /// markdown tree, where the ledger holds Loro's own byte-diff). The
    /// statement *is* the change; replay re-executes it. `batch=true`
    /// means `sql` may contain multiple `;`-separated statements (run via
    /// `Connection::execute_batch`, no bound params — the "Run SQL"
    /// console's path); `batch=false` means exactly one statement, with
    /// `params` bound positionally (`?1`, `?2`, ...) — the basic table
    /// UI's path for anything that needs to safely carry arbitrary cell
    /// values (an insert/update with a string containing `;` or quotes,
    /// say) without building SQL text by hand.
    ///
    /// One consequence of logging the statement rather than its effect: a
    /// non-deterministic statement (`CURRENT_TIMESTAMP`, `RANDOM()`, ...)
    /// replays as a *new* evaluation each time, not a reproduction of the
    /// original result. Fine for the common case (values come from the
    /// caller as bound params, which *are* replayed verbatim), just not
    /// something this module tries to paper over for SQL that computes its
    /// own values server-side.
    Exec {
        db: String,
        sql: String,
        #[serde(default)]
        params: Vec<JsonValue>,
        #[serde(default)]
        batch: bool,
    },
    /// Rolls `db` back to right after the `Exec` at position `to_index`
    /// (an index into that database's own timeline — see the module doc
    /// comment). Every `Exec` recorded for `db` after this one in ledger
    /// order is dropped from the live timeline, but never from the log.
    Revert { db: String, to_index: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseDto {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDto {
    pub name: String,
    pub sql_type: String,
    pub not_null: bool,
    pub primary_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDto {
    pub name: String,
    pub columns: Vec<ColumnDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRowsDto {
    pub columns: Vec<ColumnDto>,
    /// Every row's `rowid` first, then one value per `columns` entry —
    /// the basic table UI's only way to address "this row" for an
    /// update/delete without assuming any column is itself a usable key
    /// (a `WITHOUT ROWID` table is the one case this can't address; see
    /// `table_rows`).
    pub rows: Vec<TableRowDto>,
    pub total_rows: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRowDto {
    pub rowid: i64,
    pub values: Vec<JsonValue>,
}

/// The result of an arbitrary read-only statement run through `query` —
/// the SQL editor's "run as a query" path. Unlike `TableRowsDto`, there's
/// no `rowid` (an arbitrary `SELECT` may not even name a single table,
/// let alone expose its rowid) and no pagination (a query editor result
/// set is whatever the statement itself returned, once).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResultDto {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<JsonValue>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbHistoryEntryDto {
    /// Opaque token identifying this point in `db`'s timeline —
    /// round-trips through `SqlWorkspace::revert_to`. An index into
    /// `DbHandle::execs`, but callers shouldn't rely on that.
    pub token: String,
    pub timestamp: i64,
    pub message: String,
}

/// One statement as recorded in a database's timeline — everything needed
/// to both replay it (`sql`/`params`/`batch`) and describe it in a history
/// panel (`ts`).
#[derive(Debug, Clone)]
struct ExecRecord {
    sql: String,
    params: Vec<JsonValue>,
    batch: bool,
    ts: i64,
}

struct DbHandle {
    name: String,
    conn: Connection,
    /// Every `Exec` ever recorded for this database, in first-replay
    /// order — a purely positional list, never reordered or renumbered
    /// even across a revert (see module doc comment).
    execs: Vec<ExecRecord>,
    /// Indices into `execs` currently "in effect" — what `conn` was
    /// actually rebuilt from. Equal to `0..execs.len()` until the first
    /// revert; a revert truncates it and `rebuild()` replays exactly this
    /// subsequence into a fresh connection.
    timeline: Vec<usize>,
}

impl DbHandle {
    fn new(name: String) -> Result<Self> {
        Ok(Self { name, conn: Connection::open_in_memory().map_err(sql_err)?, execs: Vec::new(), timeline: Vec::new() })
    }

    /// Runs `sql` against the live connection, then — only once it's
    /// actually succeeded — records it in the timeline. Executing first
    /// means a syntax error or constraint violation surfaces to the
    /// caller without ever touching the ledger, the same "compute the
    /// change, then persist it" order `doc::DendroidDocument` uses.
    fn apply_exec(&mut self, sql: &str, params: &[JsonValue], batch: bool, ts: i64) -> Result<()> {
        exec_statement(&self.conn, sql, params, batch)?;
        self.timeline.push(self.execs.len());
        self.execs.push(ExecRecord { sql: sql.to_string(), params: params.to_vec(), batch, ts });
        Ok(())
    }

    fn revert(&mut self, to_index: u64) -> Result<()> {
        self.timeline.retain(|&i| (i as u64) <= to_index);
        self.rebuild()
    }

    /// Replays exactly `self.timeline` (in order) into a brand-new
    /// in-memory connection and swaps it in — the only way `timeline` can
    /// legitimately shrink (a revert), since SQLite has no "undo this one
    /// statement" primitive to run in reverse.
    fn rebuild(&mut self) -> Result<()> {
        let conn = Connection::open_in_memory().map_err(sql_err)?;
        for &i in &self.timeline {
            let rec = &self.execs[i];
            exec_statement(&conn, &rec.sql, &rec.params, rec.batch)?;
        }
        self.conn = conn;
        Ok(())
    }
}

fn sql_err(e: rusqlite::Error) -> DendroidError {
    DendroidError::Sql(e.to_string())
}

fn parse_ts(ts: &str) -> i64 {
    DateTime::parse_from_rfc3339(ts).map(|dt| dt.with_timezone(&Utc).timestamp()).unwrap_or(0)
}

fn json_to_sql(v: &JsonValue) -> SqlValue {
    match v {
        JsonValue::Null => SqlValue::Null,
        JsonValue::Bool(b) => SqlValue::Integer(*b as i64),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else if let Some(f) = n.as_f64() {
                SqlValue::Real(f)
            } else {
                SqlValue::Null
            }
        }
        JsonValue::String(s) => SqlValue::Text(s.clone()),
        // Arrays/objects have no SQLite equivalent — best-effort as JSON
        // text rather than rejecting the whole statement over one odd
        // param; a caller that cares can always pre-serialize itself.
        other => SqlValue::Text(other.to_string()),
    }
}

fn sql_to_json(v: ValueRef) -> JsonValue {
    match v {
        ValueRef::Null => JsonValue::Null,
        ValueRef::Integer(i) => JsonValue::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map(JsonValue::Number).unwrap_or(JsonValue::Null),
        ValueRef::Text(t) => JsonValue::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => JsonValue::String(base64_encode(b)),
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.encode(bytes)
}

fn exec_statement(conn: &Connection, sql: &str, params: &[JsonValue], batch: bool) -> Result<()> {
    if batch {
        conn.execute_batch(sql).map_err(sql_err)
    } else {
        let bound: Vec<SqlValue> = params.iter().map(json_to_sql).collect();
        conn.execute(sql, rusqlite::params_from_iter(bound)).map_err(sql_err)?;
        Ok(())
    }
}

/// Double-quotes `name` as a SQL identifier, escaping any embedded `"` —
/// table names can't be bound as statement params (SQLite has no
/// parameter syntax for identifiers), so anywhere a table name has to be
/// spliced into SQL text this is how. Defense in depth alongside
/// `table_exists`'s whitelist check in `table_rows`/`list tables`'s own
/// `sqlite_master` query, which is where the identifier actually comes
/// from in every call site here.
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |_| Ok(()),
    )
    .optional()
    .map_err(sql_err)
    .map(|row| row.is_some())
}

use rusqlite::OptionalExtension as _;

fn table_columns(conn: &Connection, table: &str) -> Result<Vec<ColumnDto>> {
    let sql = format!("PRAGMA table_info({})", quote_ident(table));
    let mut stmt = conn.prepare(&sql).map_err(sql_err)?;
    let columns = stmt
        .query_map([], |row| {
            Ok(ColumnDto {
                name: row.get::<_, String>(1)?,
                sql_type: row.get::<_, String>(2)?,
                not_null: row.get::<_, i64>(3)? != 0,
                primary_key: row.get::<_, i64>(5)? != 0,
            })
        })
        .map_err(sql_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sql_err)?;
    Ok(columns)
}

fn summarize_sql(sql: &str) -> String {
    let trimmed = sql.trim();
    let truncated: String = trimmed.chars().take(80).collect();
    if truncated.chars().count() < trimmed.chars().count() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

/// Applies one replayed event to the in-memory catalog. Free function
/// (rather than a method) so `open`'s initial replay and `poll_external`'s
/// ongoing tailing share the exact same logic without fighting the
/// borrow checker over `&mut self` while also holding `self.ledger`
/// borrowed for the cursor's storage handle.
fn apply_event(dbs: &mut HashMap<String, DbHandle>, deleted: &mut HashSet<String>, ev: DbEvent, ts: i64) -> Result<()> {
    match ev {
        DbEvent::Create { db, name } => {
            // A stray recreate of an id that was already deleted (shouldn't
            // happen — ids are fresh uuids — but a corrupted/hand-edited
            // ledger could) never resurrects it silently.
            if deleted.contains(&db) {
                return Ok(());
            }
            dbs.entry(db).or_insert(DbHandle::new(name)?);
        }
        DbEvent::Delete { db } => {
            dbs.remove(&db);
            deleted.insert(db);
        }
        DbEvent::Exec { db, sql, params, batch } => {
            // An exec for an unknown/already-deleted database is ignored
            // rather than failing the whole replay — same "one bad record
            // must never brick the workspace" spirit as a malformed ledger
            // line.
            if let Some(handle) = dbs.get_mut(&db) {
                if let Err(e) = handle.apply_exec(&sql, &params, batch, ts) {
                    eprintln!("[sqldb] {db}: replayed statement failed, skipping: {e}");
                }
            }
        }
        DbEvent::Revert { db, to_index } => {
            if let Some(handle) = dbs.get_mut(&db) {
                handle.revert(to_index)?;
            }
        }
    }
    Ok(())
}

/// Every SQLite database in a workspace, replayed from (and appended to)
/// its own `db-ledger/` directory — see the module doc comment.
pub struct SqlWorkspace<S: LedgerStorage> {
    ledger: LedgerWriter<S, DbEvent>,
    cursor: LedgerCursor<DbEvent>,
    dbs: HashMap<String, DbHandle>,
    deleted: HashSet<String>,
    /// This process's own session id — see `poll_external` for why
    /// `poll_external` needs it (unlike `DendroidDocument`, which never
    /// has to check: reimporting a Loro update it already applied is a
    /// safe no-op, but re-running a SQL statement generally isn't).
    session_id: String,
}

impl<S: LedgerStorage> SqlWorkspace<S> {
    /// Opens (or creates) a workspace's SQL store backed by `storage`:
    /// replays every existing `db-ledger/` file into fresh in-memory
    /// SQLite connections (one per live database) and opens this
    /// session's own ledger file for subsequent appends. Mirrors
    /// `DendroidDocument::open`'s shape closely on purpose.
    pub async fn open(storage: S, session_id: impl Into<String>) -> Result<Self> {
        let session_id = session_id.into();
        let mut dbs = HashMap::new();
        let mut deleted = HashSet::new();
        let mut cursor: LedgerCursor<DbEvent> = LedgerCursor::new();
        for record in cursor.poll(&storage).await? {
            apply_event(&mut dbs, &mut deleted, record.payload, parse_ts(&record.ts))?;
        }

        let ledger = LedgerWriter::open(storage, session_id.clone()).await?;
        Ok(Self { ledger, cursor, dbs, deleted, session_id })
    }

    /// Every live database, name-sorted — what the sidebar's database list
    /// renders.
    pub fn list_databases(&self) -> Vec<DatabaseDto> {
        let mut list: Vec<_> = self.dbs.iter().map(|(id, h)| DatabaseDto { id: id.clone(), name: h.name.clone() }).collect();
        list.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
        list
    }

    /// Creates a new, empty database and ledgers it. Returns the fresh id.
    pub async fn create_database(&mut self, name: &str) -> Result<String> {
        let id = uuid::Uuid::new_v4().to_string();
        self.dbs.insert(id.clone(), DbHandle::new(name.to_string())?);
        self.ledger.append(DbEvent::Create { db: id.clone(), name: name.to_string() }).await?;
        Ok(id)
    }

    /// Removes a database from the live set and ledgers the delete. See
    /// `DbEvent::Delete` for why this isn't itself revertible.
    pub async fn delete_database(&mut self, id: &str) -> Result<()> {
        if !self.dbs.contains_key(id) {
            return Err(DendroidError::DbNotFound(id.to_string()));
        }
        self.dbs.remove(id);
        self.deleted.insert(id.to_string());
        self.ledger.append(DbEvent::Delete { db: id.to_string() }).await
    }

    /// Runs one statement against `id` (or, if `batch`, a `;`-separated
    /// script) and ledgers it — see `DbEvent::Exec`. Fails without
    /// touching the ledger if the statement itself fails (a syntax error,
    /// a constraint violation, ...).
    pub async fn exec(&mut self, id: &str, sql: &str, params: Vec<JsonValue>, batch: bool) -> Result<()> {
        let ts = Utc::now().timestamp();
        {
            let handle = self.dbs.get_mut(id).ok_or_else(|| DendroidError::DbNotFound(id.to_string()))?;
            handle.apply_exec(sql, &params, batch, ts)?;
        }
        self.ledger.append(DbEvent::Exec { db: id.to_string(), sql: sql.to_string(), params, batch }).await
    }

    /// Every user table in `id`, with its columns — what the table list in
    /// the database view renders. Excludes SQLite's own internal
    /// `sqlite_*` tables.
    pub fn list_tables(&self, id: &str) -> Result<Vec<TableDto>> {
        let handle = self.dbs.get(id).ok_or_else(|| DendroidError::DbNotFound(id.to_string()))?;
        let mut stmt = handle
            .conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")
            .map_err(sql_err)?;
        let names: Vec<String> = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(sql_err)?.collect::<rusqlite::Result<_>>().map_err(sql_err)?;
        drop(stmt);
        names.into_iter().map(|name| Ok(TableDto { columns: table_columns(&handle.conn, &name)?, name })).collect()
    }

    /// A page of `table`'s rows in `id`, plus the total row count (for
    /// pagination) and column metadata. Ordered by `rowid` unless
    /// `order_by` names a real column of `table` (or the literal
    /// `"rowid"`), in which case that column is used instead —
    /// `order_desc` picks the direction. `order_by` is checked against
    /// `table`'s own column list rather than spliced straight into the
    /// SQL text, since a column name can't be bound as a statement param
    /// (same reasoning as `quote_ident`'s doc comment) and this is the
    /// one place a caller-supplied identifier reaches this module.
    ///
    /// `rowid` is SQLite's own implicit row id — used here as the row
    /// identity the table UI's edit/delete actions address, rather than
    /// assuming any user column is unique. A `WITHOUT ROWID` table has
    /// none, so it's browsable (`list_tables`) but not addressable
    /// through this call — same limitation basic spreadsheet-style table
    /// UIs commonly accept.
    pub fn table_rows(
        &self,
        id: &str,
        table: &str,
        limit: u32,
        offset: u32,
        order_by: Option<&str>,
        order_desc: bool,
    ) -> Result<TableRowsDto> {
        let handle = self.dbs.get(id).ok_or_else(|| DendroidError::DbNotFound(id.to_string()))?;
        if !table_exists(&handle.conn, table)? {
            return Err(DendroidError::TableNotFound(table.to_string()));
        }
        let quoted = quote_ident(table);
        let columns = table_columns(&handle.conn, table)?;

        let order_col = match order_by {
            Some(col) if col == "rowid" || columns.iter().any(|c| c.name == col) => quote_ident(col),
            Some(col) => return Err(DendroidError::Sql(format!("unknown column {col:?}"))),
            None => quote_ident("rowid"),
        };
        let dir = if order_desc { "DESC" } else { "ASC" };

        let total_rows: u64 = handle
            .conn
            .query_row(&format!("SELECT COUNT(*) FROM {quoted}"), [], |row| row.get::<_, i64>(0))
            .map_err(sql_err)? as u64;

        let sql = format!("SELECT rowid, * FROM {quoted} ORDER BY {order_col} {dir} LIMIT ?1 OFFSET ?2");
        let mut stmt = handle.conn.prepare(&sql).map_err(sql_err)?;
        let col_count = columns.len();
        let rows: Vec<TableRowDto> = stmt
            .query_map(rusqlite::params![limit, offset], |row| {
                let rowid: i64 = row.get(0)?;
                let mut values = Vec::with_capacity(col_count);
                for i in 0..col_count {
                    values.push(sql_to_json(row.get_ref(i + 1)?));
                }
                Ok(TableRowDto { rowid, values })
            })
            .map_err(sql_err)?
            .collect::<rusqlite::Result<_>>()
            .map_err(sql_err)?;

        Ok(TableRowsDto { columns, rows, total_rows })
    }

    /// Runs a single read-only statement against `id` and returns whatever
    /// it selected — the SQL editor's "run as a query" path for a `SELECT`/
    /// `PRAGMA`/`EXPLAIN`/... typed into the console, as opposed to `exec`'s
    /// path for anything that mutates. Deliberately *not* ledgered: a read
    /// has no effect to replay, and unlike `exec` it doesn't go through
    /// `DbHandle::apply_exec` at all, so nothing here touches `timeline`.
    ///
    /// Rejects (via `stmt.readonly()`, SQLite's own "does this statement
    /// write to the database file" check) anything that isn't actually
    /// read-only — the caller should fall back to `exec` for those. That
    /// guard exists because this method runs the statement directly
    /// against the live connection without recording it anywhere: letting
    /// a write through here would silently bypass the ledger the same way
    /// a raw `rusqlite` call from outside this module would.
    pub fn query(&self, id: &str, sql: &str) -> Result<QueryResultDto> {
        let handle = self.dbs.get(id).ok_or_else(|| DendroidError::DbNotFound(id.to_string()))?;
        let mut stmt = handle.conn.prepare(sql).map_err(sql_err)?;
        if !stmt.readonly() {
            return Err(DendroidError::Sql("statement is not read-only — run it from the SQL editor's exec path instead".to_string()));
        }
        let columns: Vec<String> = stmt.column_names().into_iter().map(str::to_string).collect();
        let col_count = columns.len();
        let rows: Vec<Vec<JsonValue>> = stmt
            .query_map([], |row| {
                let mut values = Vec::with_capacity(col_count);
                for i in 0..col_count {
                    values.push(sql_to_json(row.get_ref(i)?));
                }
                Ok(values)
            })
            .map_err(sql_err)?
            .collect::<rusqlite::Result<_>>()
            .map_err(sql_err)?;
        Ok(QueryResultDto { columns, rows })
    }

    /// `id`'s currently-live timeline, most recent first — what a history
    /// panel lists, each with a `token` `revert_to` accepts to roll `id`
    /// back to right after that statement. Mirrors `history::history`'s
    /// shape closely on purpose (see `HistoryEntryDto`) so the frontend's
    /// History view can render either with the same layout.
    pub fn history(&self, id: &str) -> Result<Vec<DbHistoryEntryDto>> {
        let handle = self.dbs.get(id).ok_or_else(|| DendroidError::DbNotFound(id.to_string()))?;
        Ok(handle
            .timeline
            .iter()
            .rev()
            .map(|&i| {
                let rec = &handle.execs[i];
                DbHistoryEntryDto { token: i.to_string(), timestamp: rec.ts, message: summarize_sql(&rec.sql) }
            })
            .collect())
    }

    /// Rolls `id` back to `token` (a `DbHistoryEntryDto.token` from a
    /// previous `history` call) — see the module doc comment for why this
    /// is a full rebuild-from-timeline-prefix rather than a diff, unlike
    /// `history::revert_to`.
    pub async fn revert_to(&mut self, id: &str, token: &str) -> Result<()> {
        let to_index: u64 =
            token.parse().map_err(|_| DendroidError::Sql(format!("invalid history token {token:?}")))?;
        {
            let handle = self.dbs.get_mut(id).ok_or_else(|| DendroidError::DbNotFound(id.to_string()))?;
            if to_index as usize >= handle.execs.len() {
                return Err(DendroidError::Sql(format!("history token {token:?} out of range")));
            }
            handle.revert(to_index)?;
        }
        self.ledger.append(DbEvent::Revert { db: id.to_string(), to_index }).await
    }

    /// Tail `db-ledger/` for records this process hasn't seen yet —
    /// mirrors `DendroidDocument::poll_external`'s shape ("own session's
    /// file, poll everyone else's"), but with one crucial difference: a
    /// Loro update is a CRDT op, so `DendroidDocument` can safely reimport
    /// its own already-applied writes (a no-op merge) the first time its
    /// cursor happens to see its own file. A SQL statement generally
    /// isn't idempotent — re-running `CREATE TABLE`/`INSERT` a second time
    /// errors or duplicates rows — so this session's own records (already
    /// applied directly by `create_database`/`exec`/`delete_database`/
    /// `revert_to` at the moment they were made) are skipped here rather
    /// than replayed again.
    pub async fn poll_external(&mut self) -> Result<bool> {
        let records = self.cursor.poll(self.ledger.storage()).await?;
        let mut changed = false;
        for record in records {
            if record.session_id == self.session_id {
                continue;
            }
            let ts = parse_ts(&record.ts);
            apply_event(&mut self.dbs, &mut self.deleted, record.payload, ts)?;
            changed = true;
        }
        Ok(changed)
    }
}
