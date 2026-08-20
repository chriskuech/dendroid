import type { MaterializeSettings } from "../../lib/types";

export interface MaterializeAdapter {
  /** Applies Settings' "Storage > Materialize" switches (`src-tauri`'s
   * `materialize` module) — turning one on schedules a debounced write of
   * that plain-file projection for every currently open workspace; turning
   * it off just stops scheduling new ones (existing files on disk are left
   * alone, same "nothing here deletes user data" stance as turning off
   * encryption). No-op outside Tauri (see `unavailable.ts`) — there's no
   * process to write those files from in the web/wasm preview build. */
  applyMaterializeConfig(materialize: MaterializeSettings): Promise<void>;
}
