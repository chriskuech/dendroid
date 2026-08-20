import type { MaterializeAdapter } from "./types";

export function createTauriMaterialize(): MaterializeAdapter {
  return {
    async applyMaterializeConfig(materialize) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("materialize_set_config", { markdown: materialize.markdown, dbs: materialize.dbs });
      } catch (err) {
        console.error("[materialize] failed to apply config", err);
      }
    },
  };
}
