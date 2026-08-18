import { hasTauriBridge } from "../detectPlatform";
import { createTauriDialog } from "./tauri";
import { createWebDialog } from "./web";
import type { DialogAdapter } from "./types";

export type { DialogAdapter };

export const adapter: DialogAdapter = hasTauriBridge() ? createTauriDialog() : createWebDialog();
