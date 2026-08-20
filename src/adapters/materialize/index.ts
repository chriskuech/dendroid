import { hasTauriBridge } from "../detectPlatform";
import { createTauriMaterialize } from "./tauri";
import { createUnavailableMaterialize } from "./unavailable";
import type { MaterializeAdapter } from "./types";

export type { MaterializeAdapter };

export const adapter: MaterializeAdapter = hasTauriBridge() ? createTauriMaterialize() : createUnavailableMaterialize();
