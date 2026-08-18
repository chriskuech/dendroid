// Talks to the `db_*` Tauri commands (`src-tauri/src/commands.rs`), which
// delegate to `dendroid_core::sqldb::SqlWorkspace` — see that module's doc
// comment for why SQL databases are a second, independently-ledgered store
// alongside the markdown tree rather than living inside the same Loro
// document `lib/crdt/document.ts` mirrors.
//
// Native-only for now, same as `sqldb` itself (no wasm build of the SQL
// store exists yet — see that module's doc comment for the scope
// decision): `unavailable.ts` throws `DatabasesUnavailableError` for every
// method outside Tauri. Unlike `adapters/platform`'s `DocBackend`, there's
// no in-memory preview fallback — a database's whole point is durable,
// revertible history, so a fake unpersisted one would be actively
// misleading rather than merely degraded.

/** Mirrors `dendroid_core::sqldb::DatabaseDto`. */
export interface DatabaseDto {
  id: string;
  name: string;
}

/** Mirrors `dendroid_core::sqldb::ColumnDto`. */
export interface ColumnDto {
  name: string;
  sqlType: string;
  notNull: boolean;
  primaryKey: boolean;
}

/** Mirrors `dendroid_core::sqldb::TableDto`. */
export interface TableDto {
  name: string;
  columns: ColumnDto[];
}

/** Mirrors `dendroid_core::sqldb::TableRowDto` — `rowid` is SQLite's own
 * implicit row id, used to address a row for an edit/delete without
 * assuming any column of its own is a usable key. */
export interface TableRowDto {
  rowid: number;
  values: unknown[];
}

/** Mirrors `dendroid_core::sqldb::TableRowsDto`. */
export interface TableRowsDto {
  columns: ColumnDto[];
  rows: TableRowDto[];
  totalRows: number;
}

/** Mirrors `dendroid_core::sqldb::QueryResultDto` — the shape of running a
 * read-only statement (a `SELECT`, typically) through `queryDb` rather than
 * a mutation through `execSql`. No `rowid` and no pagination, unlike
 * `TableRowsDto`: an arbitrary query result isn't addressable the way a
 * single table's rows are. */
export interface QueryResultDto {
  columns: string[];
  rows: unknown[][];
}

/** Mirrors `dendroid_core::sqldb::DbHistoryEntryDto` — deliberately the
 * same shape as `lib/crdt/history.ts`'s `HistoryEntryDto` (token/
 * timestamp/message) so a history panel can render either with the same
 * layout; see `ux/history/DatabaseHistoryView.tsx`. */
export interface DbHistoryEntryDto {
  token: string;
  timestamp: number;
  message: string;
}

/** Thrown by every `DbAdapter` method outside Tauri. Reads as a complete
 * explanation on its own, so callers can generally just show `err.message`
 * rather than special-casing this type. */
export class DatabasesUnavailableError extends Error {
  constructor() {
    super("Databases aren't available in this build yet — open Dendroid as a desktop app to use them.");
    this.name = "DatabasesUnavailableError";
  }
}

export interface DbAdapter {
  /** Every live database in the current workspace, name-sorted — what
   * `DatabaseListView` renders. */
  listDatabases(): Promise<DatabaseDto[]>;

  /** One database's own DTO (id + name), or `null` if it's been deleted —
   * there's no dedicated backend lookup for a single id, so this is just
   * `listDatabases` filtered. Used by `Workspace.tsx` to resolve the
   * display name for whichever id is currently open in the main area, and
   * to notice when that database has been deleted out from under it. */
  getDatabase(id: string): Promise<DatabaseDto | null>;

  /** Creates a new, empty database and returns its fresh id. */
  createDatabase(name: string): Promise<string>;

  /** Removes a database from the live set. Not itself revertible — see
   * `dendroid_core::sqldb::DbEvent::Delete`. */
  deleteDatabase(id: string): Promise<void>;

  /** Runs one statement (or, if `batch`, a `;`-separated script) against
   * `id` and ledgers it. What every basic-table-UI action (insert/update/
   * delete a row, create/alter/drop a table) and the SQL editor's mutating
   * statements both go through — a read-only statement typed there goes
   * through `queryDb` instead. Rejects — without ledgering anything — if
   * the statement itself fails (bad syntax, a constraint violation, ...). */
  execSql(id: string, sql: string, params?: unknown[], batch?: boolean): Promise<void>;

  /** Every user table in `id`, with its columns — what the database
   * view's table list renders. */
  listTables(id: string): Promise<TableDto[]>;

  /** A page of `table`'s rows in `id`, ordered by `rowid` unless
   * `orderBy` names a column to sort by instead (`orderDesc` picks the
   * direction) — what the database view's data grid renders, including
   * its clickable sortable column headers. */
  tableRows(
    id: string,
    table: string,
    limit: number,
    offset: number,
    orderBy?: string | null,
    orderDesc?: boolean,
  ): Promise<TableRowsDto>;

  /** Runs a single read-only statement (a `SELECT`, typically) against
   * `id` and returns whatever it selected — the SQL editor's "run as a
   * query" path. Rejects if `sql` isn't actually read-only (see
   * `dendroid_core::sqldb::SqlWorkspace::query`); the caller should fall
   * back to `execSql` for those. Unlike `execSql`, this never ledgers
   * anything and never fires an update — nothing about `id` changed. */
  queryDb(id: string, sql: string): Promise<QueryResultDto>;

  /** `id`'s change history, most recent first — what the History sidebar
   * tab shows while a database (rather than the tree) is open. */
  dbHistory(id: string): Promise<DbHistoryEntryDto[]>;

  /** Rolls `id` back to `token` (a `DbHistoryEntryDto.token` from a
   * previous `dbHistory` call). Nothing is erased — see
   * `dendroid_core::sqldb`'s module doc comment for why a later edit still
   * lands as a new entry on top rather than being blocked by the revert. */
  dbRevertTo(id: string, token: string): Promise<void>;

  /** Subscribes to database change events — fired after any database
   * mutation this window made itself, or one the background ledger-poll
   * thread merged in from another session/replica
   * (`src-tauri/src/lib.rs`). There's no delta payload to decode: a
   * subscriber just re-fetches whatever it's currently showing, the same
   * way `HistoryView.tsx` already reacts to the CRDT's own `onUpdate` by
   * re-fetching rather than diffing. Returns an unsubscribe function. */
  onDatabasesChanged(callback: () => void): () => void;
}
