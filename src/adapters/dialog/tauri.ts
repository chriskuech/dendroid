import type { DialogAdapter } from "./types";

export function createTauriDialog(): DialogAdapter {
  return {
    async pickFolder(defaultPath) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false, defaultPath });
      return typeof selected === "string" ? selected : null;
    },
  };
}
