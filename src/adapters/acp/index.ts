import { hasTauriBridge } from "../detectPlatform";
import { createTauriAcp } from "./tauri";
import { createUnavailableAcp } from "./unavailable";
import type { AcpAdapter } from "./types";

export type { AcpAdapter, AcpBridgeEvent, AcpPermissionOption, AcpUpdate } from "./types";
export { AgentUnavailableError } from "./types";

export const adapter: AcpAdapter = hasTauriBridge() ? createTauriAcp() : createUnavailableAcp();
