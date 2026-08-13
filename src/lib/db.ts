// Talks to the `db_*` Tauri commands (`src-tauri/src/commands.rs`), which
// delegate to `dendroid_core::sqldb::SqlWorkspace` — see that module's doc
// comment for why SQL databases are a second, independently-ledgered store
// alongside the markdown tree rather than living inside the same Loro
// document `lib/crdt/document.ts` mirrors.
//
// Native-only for now, same as `sqldb` itself (no wasm build of the SQL
// store exists yet — see that module's doc comment for the scope
// decision): every export here throws `DatabasesUnavailableError` outside
// Tauri, mirroring the guard `mcp.ts`'s `applyMcpConfig` and `dialog.ts`'s
// `pickFolder` already use for other Tauri-only features. Unlike
// `lib/crdt/document.ts`, there's no in-memory preview fallback — a
// database's whole point is durable, revertible history, so a fake
// unpersisted one would be actively misleading rather than merely
// degraded.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirrors `dendroid_core::sqldb::DB_UPDATE_EVENT` (`src-tauri/src/
 * commands.rs`). */
const DB_UPDATE_EVENT = "db://update";

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
 * layout; see `components/history/DatabaseHistoryView.tsx`. */
export interface DbHistoryEntryDto {
  token: string;
  timestamp: number;
  message: string;
}

/** Mirrors the check `dialog.ts`/`mcp.ts`/`platform/index.ts` each do —
 * same convention, kept local to each file rather than centralized. */
export function hasTauriBridge(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Thrown by every export below outside Tauri. Reads as a complete
 * explanation on its own, so callers can generally just show `err.message`
 * rather than special-casing this type. */
export class DatabasesUnavailableError extends Error {
  constructor() {
    super("Databases aren't available in this build yet — open Dendroid as a desktop app to use them.");
    this.name = "DatabasesUnavailableError";
  }
}

// `requireTauri` throws synchronously, so every export below is declared
// `async` (even though most just delegate straight to `invoke`) rather
// than a plain function returning `invoke(...)`'s promise — a plain
// function's synchronous throw happens *before* any `Promise` exists to
// reject, so a caller's `.catch(...)` would never see it (it would
// instead surface as an uncaught exception wherever the call itself sits,
// e.g. inside a `useEffect`). `async` guarantees a throw anywhere in the
// body always becomes a rejected promise instead.
function requireTauri(): void {
  if (!hasTauriBridge()) throw new DatabasesUnavailableError();
}

/** Every live database in the current workspace, name-sorted — what
 * `DatabaseListView` renders. */
export async function listDatabases(): Promise<DatabaseDto[]> {
  requireTauri();
  return invoke<DatabaseDto[]>("db_list");
}

/** One database's own DTO (id + name), or `null` if it's been deleted —
 * there's no dedicated backend lookup for a single id, so this is just
 * `listDatabases` filtered. Used by `Workspace.tsx` to resolve the display
 * name for whichever id is currently open in the main area, and to notice
 * when that database has been deleted out from under it. */
export async function getDatabase(id: string): Promise<DatabaseDto | null> {
  const list = await listDatabases();
  return list.find((d) => d.id === id) ?? null;
}

/** Creates a new, empty database and returns its fresh id. */
export async function createDatabase(name: string): Promise<string> {
  requireTauri();
  return invoke<string>("db_create", { name });
}

/** Removes a database from the live set. Not itself revertible — see
 * `dendroid_core::sqldb::DbEvent::Delete`. */
export async function deleteDatabase(id: string): Promise<void> {
  requireTauri();
  return invoke("db_delete", { id });
}

/** Runs one statement (or, if `batch`, a `;`-separated script) against
 * `id` and ledgers it. What every basic-table-UI action (insert/update/
 * delete a row, create/alter/drop a table) and the SQL editor's mutating
 * statements both go through — a read-only statement typed there goes
 * through `queryDb` instead. Rejects — without ledgering anything — if the statement
 * itself fails (bad syntax, a constraint violation, ...). */
export async function execSql(id: string, sql: string, params: unknown[] = [], batch = false): Promise<void> {
  requireTauri();
  return invoke("db_exec", { id, sql, params, batch });
}

/** Every user table in `id`, with its columns — what the database view's
 * table list renders. */
export async function listTables(id: string): Promise<TableDto[]> {
  requireTauri();
  return invoke<TableDto[]>("db_tables", { id });
}

/** A page of `table`'s rows in `id`, ordered by `rowid` unless `orderBy`
 * names a column to sort by instead (`orderDesc` picks the direction) —
 * what the database view's data grid renders, including its clickable
 * sortable column headers. */
export async function tableRows(
  id: string,
  table: string,
  limit: number,
  offset: number,
  orderBy?: string | null,
  orderDesc?: boolean,
): Promise<TableRowsDto> {
  requireTauri();
  return invoke<TableRowsDto>("db_table_rows", { id, table, limit, offset, orderBy: orderBy ?? null, orderDesc: orderDesc ?? false });
}

/** Runs a single read-only statement (a `SELECT`, typically) against `id`
 * and returns whatever it selected — the SQL editor's "run as a query"
 * path. Rejects if `sql` isn't actually read-only (see
 * `dendroid_core::sqldb::SqlWorkspace::query`); the caller should fall back
 * to `execSql` for those. Unlike `execSql`, this never ledgers anything and
 * never fires `db://update` — nothing about `id` changed. */
export async function queryDb(id: string, sql: string): Promise<QueryResultDto> {
  requireTauri();
  return invoke<QueryResultDto>("db_query", { id, sql });
}

/** `id`'s change history, most recent first — what the History sidebar
 * tab shows while a database (rather than the tree) is open. */
export async function dbHistory(id: string): Promise<DbHistoryEntryDto[]> {
  requireTauri();
  return invoke<DbHistoryEntryDto[]>("db_history", { id });
}

/** Rolls `id` back to `token` (a `DbHistoryEntryDto.token` from a previous
 * `dbHistory` call). Nothing is erased — see `dendroid_core::sqldb`'s
 * module doc comment for why a later edit still lands as a new entry on
 * top rather than being blocked by the revert. */
export async function dbRevertTo(id: string, token: string): Promise<void> {
  requireTauri();
  return invoke("db_revert_to", { id, token });
}

/** Subscribes to `db://update` — fired after any database mutation this
 * window made itself, or one the background ledger-poll thread merged in
 * from another session/replica (`src-tauri/src/lib.rs`). Unlike
 * `TauriDocBackend.onRemoteUpdate`, there's no delta payload to decode: a
 * subscriber just re-fetches whatever it's currently showing, the same
 * way `HistoryView.tsx` already reacts to the CRDT's own `onUpdate` by
 * re-fetching rather than diffing. No-op outside Tauri. Returns an
 * unsubscribe function. */
export function onDatabasesChanged(callback: () => void): () => void {
  if (!hasTauriBridge()) return () => {};

  let unlisten: UnlistenFn | null = null;
  let cancelled = false;
  void listen(DB_UPDATE_EVENT, () => callback()).then((fn) => {
    if (cancelled) fn();
    else unlisten = fn;
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
