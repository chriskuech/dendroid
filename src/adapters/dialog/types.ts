/** Native folder picker (Tauri) or, in a plain browser, the File System
 * Access API's directory picker — see `tauri.ts`/`web.ts`. The web case has
 * no real path to hand back — the API deliberately never leaks one — so it
 * returns the picked folder's own name instead. That name doubles as both
 * the `DocBackend` workspace identifier (`adapters/platform/wasm.ts`) and
 * the IndexedDB lookup key the handle itself is stashed under
 * (`adapters/platform/fsHandles.ts`, since there's no path string a later
 * reload could use to ask for the same folder again). */
export interface DialogAdapter {
  pickFolder(defaultPath?: string): Promise<string | null>;
}
