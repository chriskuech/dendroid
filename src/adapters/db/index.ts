import { hasTauriBridge } from "../detectPlatform";
import { createTauriDb } from "./tauri";
import { createUnavailableDb } from "./unavailable";
import type { DbAdapter } from "./types";

export type { ColumnDto, DatabaseDto, DbAdapter, DbHistoryEntryDto, QueryResultDto, TableDto, TableRowDto, TableRowsDto } from "./types";
export { DatabasesUnavailableError } from "./types";

export const adapter: DbAdapter = hasTauriBridge() ? createTauriDb() : createUnavailableDb();
