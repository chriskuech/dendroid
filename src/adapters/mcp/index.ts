import { hasTauriBridge } from "../detectPlatform";
import { createTauriMcp } from "./tauri";
import { createUnavailableMcp } from "./unavailable";
import type { McpAdapter, McpSkill } from "./types";

export type { McpAdapter, McpSkill };

export const adapter: McpAdapter = hasTauriBridge() ? createTauriMcp() : createUnavailableMcp();
