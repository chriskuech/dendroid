/**
 * Native folder picker (Tauri) or, in a plain browser, the File System
 * Access API's directory picker. The web case has no real path to hand
 * back — the API deliberately never leaks one — so it returns the picked
 * folder's own name instead. That name doubles as both the `DocBackend`
 * workspace identifier (`platform/wasm.ts`) and the IndexedDB lookup key
 * the handle itself is stashed under (`platform/fsHandles.ts`, since
 * there's no path string a later reload could use to ask for the same
 * folder again).
 */
export async function pickFolder(defaultPath?: string): Promise<string | null> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false, defaultPath });
    return typeof selected === "string" ? selected : null;
  }

  if (typeof window === "undefined" || !window.showDirectoryPicker) {
    console.warn("[dialog] No folder picker available (needs Tauri, or a browser with the File System Access API).");
    return null;
  }

  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    const { putWorkspaceHandle } = await import("./platform/fsHandles");
    await putWorkspaceHandle(handle.name, handle);
    return handle.name;
  } catch (err) {
    // The user closing the picker without choosing anything isn't a failure.
    if (err instanceof DOMException && err.name === "AbortError") return null;
    throw err;
  }
}
