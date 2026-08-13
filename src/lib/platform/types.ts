/**
 * What `DendroidDocument` (`lib/crdt/document.ts`) needs from whichever
 * platform is actually running it: Tauri's IPC bridge to a native
 * `dendroid_core::native::NativeDocument` (`tauri.ts`), or the web build's
 * wasm `WebDocument` (`wasm.ts`, from `src-web`), backed by a real
 * user-picked directory via the File System Access API. Both speak the
 * same shape here so the CRDT mirror code never needs to know which one
 * it's talking to — see `index.ts`'s `createDocBackend` for how one gets
 * picked.
 */

import type { HistoryEntryDto } from "../crdt/history";

export interface DocBackend {
  /**
   * Opens (or creates) a workspace and returns the initial Loro snapshot
   * to seed the frontend mirror. `identifier` is a filesystem path for
   * the Tauri backend; for the wasm one it's the workspace's name, used
   * to look its `FileSystemDirectoryHandle` back up from IndexedDB (see
   * `fsHandles.ts`) — an opaque string either way as far as this
   * interface is concerned.
   */
  open(identifier: string): Promise<Uint8Array>;

  /** Persists a Loro update produced locally (via `doc.subscribeLocalUpdates`). */
  importUpdate(bytes: Uint8Array): Promise<void>;

  /**
   * Registers `callback` to receive every update that arrives from
   * elsewhere — another session/tab, another replica of the workspace, or
   * a background/poll merge — never for updates this same document
   * produced locally (those are already in the caller's own mirror by the
   * time `importUpdate` even runs). At most one callback is ever
   * registered, by `DendroidDocument.open`, so implementations don't need
   * to support more than one.
   */
  onRemoteUpdate(callback: (bytes: Uint8Array) => void): void;

  /** Every change in this document's history, most recent first — see
   * `HistoryEntryDto`. */
  history(): Promise<HistoryEntryDto[]>;

  /** Rolls the document back to `token` (a `HistoryEntryDto.token` from a
   * previous `history()` call). The resulting change reaches this mirror
   * the same way any other backend-driven change does — through
   * `onRemoteUpdate` — so there's nothing to apply here directly; this
   * just resolves once the backend has recorded the rollback. */
  revertTo(token: string): Promise<void>;

  /** Releases whatever this backend is holding (listeners, timers, wasm memory). */
  dispose(): void;
}
