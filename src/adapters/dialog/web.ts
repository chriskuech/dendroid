import type { DialogAdapter } from "./types";

export function createWebDialog(): DialogAdapter {
  return {
    async pickFolder() {
      if (typeof window === "undefined" || !window.showDirectoryPicker) {
        console.warn("[dialog] No folder picker available (needs Tauri, or a browser with the File System Access API).");
        return null;
      }

      try {
        const handle = await window.showDirectoryPicker({ mode: "readwrite" });
        const { putWorkspaceHandle } = await import("../platform/fsHandles");
        await putWorkspaceHandle(handle.name, handle);
        return handle.name;
      } catch (err) {
        // The user closing the picker without choosing anything isn't a failure.
        if (err instanceof DOMException && err.name === "AbortError") return null;
        throw err;
      }
    },
  };
}
