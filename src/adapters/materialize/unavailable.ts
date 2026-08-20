import type { MaterializeAdapter } from "./types";

/** No process to write materialized files from outside Tauri. */
export function createUnavailableMaterialize(): MaterializeAdapter {
  return {
    async applyMaterializeConfig() {},
  };
}
