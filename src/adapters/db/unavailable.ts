import { DatabasesUnavailableError, type DbAdapter } from "./types";

/** No wasm build of `sqldb` exists yet — see `types.ts`'s doc comment.
 * Every method throws outside Tauri. */
export function createUnavailableDb(): DbAdapter {
  const unavailable = async (): Promise<never> => {
    throw new DatabasesUnavailableError();
  };

  return {
    listDatabases: unavailable,
    getDatabase: unavailable,
    createDatabase: unavailable,
    deleteDatabase: unavailable,
    execSql: unavailable,
    listTables: unavailable,
    tableRows: unavailable,
    queryDb: unavailable,
    dbHistory: unavailable,
    dbRevertTo: unavailable,
    onDatabasesChanged: () => () => {},
  };
}
