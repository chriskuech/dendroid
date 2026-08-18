import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DatabaseDto, DbAdapter, DbHistoryEntryDto, QueryResultDto, TableDto, TableRowsDto } from "./types";

/** Mirrors `dendroid_core::sqldb::DB_UPDATE_EVENT` (`src-tauri/src/
 * commands.rs`). */
const DB_UPDATE_EVENT = "db://update";

export function createTauriDb(): DbAdapter {
  return {
    async listDatabases() {
      return invoke<DatabaseDto[]>("db_list");
    },

    async getDatabase(id) {
      const list = await invoke<DatabaseDto[]>("db_list");
      return list.find((d) => d.id === id) ?? null;
    },

    async createDatabase(name) {
      return invoke<string>("db_create", { name });
    },

    async deleteDatabase(id) {
      return invoke("db_delete", { id });
    },

    async execSql(id, sql, params = [], batch = false) {
      return invoke("db_exec", { id, sql, params, batch });
    },

    async listTables(id) {
      return invoke<TableDto[]>("db_tables", { id });
    },

    async tableRows(id, table, limit, offset, orderBy, orderDesc) {
      return invoke<TableRowsDto>("db_table_rows", { id, table, limit, offset, orderBy: orderBy ?? null, orderDesc: orderDesc ?? false });
    },

    async queryDb(id, sql) {
      return invoke<QueryResultDto>("db_query", { id, sql });
    },

    async dbHistory(id) {
      return invoke<DbHistoryEntryDto[]>("db_history", { id });
    },

    async dbRevertTo(id, token) {
      return invoke("db_revert_to", { id, token });
    },

    onDatabasesChanged(callback) {
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
    },
  };
}
