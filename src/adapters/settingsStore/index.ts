import { hasTauriBridge } from "../detectPlatform";
import { createTauriSettingsStore } from "./tauri";
import { createWebSettingsStore } from "./web";
import type { SettingsStoreAdapter } from "./types";

export type { SettingsStoreAdapter };

export const adapter: SettingsStoreAdapter = hasTauriBridge() ? createTauriSettingsStore() : createWebSettingsStore();
