import { hasTauriBridge } from "../detectPlatform";
import { createTauriAutomationsEngine } from "./tauri";
import { createUnavailableAutomationsEngine } from "./unavailable";
import type { AutomationsEngineAdapter } from "./types";

export type { AutomationsEngineAdapter } from "./types";
export { AutomationsUnavailableError } from "./types";

export const adapter: AutomationsEngineAdapter = hasTauriBridge()
  ? createTauriAutomationsEngine()
  : createUnavailableAutomationsEngine();
