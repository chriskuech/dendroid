// Talks to the `WebDocument` wasm bindings (`src-web`, crate
// `dendroid-web`), backed by a real directory the user picked via
// `adapters/dialog`'s `pickFolder` (File System Access API) rather than
// origin-private OPFS — see `src-web/src/fsa.rs` for why that's the
// choice: it's the only way a browser tab and a native Tauri build can
// point at the literal same folder. Built by `bun run build:wasm`
// (wasm-pack, `--target bundler`) into `src-web/pkg`, which
// `vite-plugin-wasm` + `vite-plugin-top-level-await` (see
// `vite.config.ts`) let Vite load like any other ES module. Imported
// dynamically (see `index.ts`) so the ~2.5MB wasm binary never reaches a
// Tauri build, which doesn't need it.

import { base64ToBytes, bytesToBase64 } from "../../lib/crdt/base64";
import type { EncryptionStatusDto, GeneratedEncryptionKey } from "../../lib/crdt/encryption";
import type { HistoryEntryDto } from "../../lib/crdt/history";
import { getWorkspaceHandle } from "./fsHandles";
import type { DocBackend } from "./types";
// Type-only: the value itself is loaded via dynamic `import()` in `open()`
// below, so this wasm module (and the binary behind it) is never pulled
// into a Tauri build.
import type { WebDocument } from "../../../src-web/pkg/dendroid_web";

/** How often to check the workspace folder for records written by
 * another tab/session — the web build's analog of the Tauri build's
 * background ledger-tailing thread (`src-tauri/src/lib.rs`'s `setup`
 * closure), just driven by `setInterval` instead of a spare OS thread
 * (wasm here has none to spare). */
const POLL_INTERVAL_MS = 1500;

/** Thrown when the picked folder's `FileSystemDirectoryHandle` needs its
 * read/write permission granted again — browsers don't reliably persist
 * that grant across a full restart, only within a session. Recover by
 * re-picking the same folder from Settings (`pickFolder`), which
 * re-grants permission and refreshes the stored handle. */
export class PermissionRequiredError extends Error {
  constructor(name: string) {
    super(`Permission to access "${name}" needs to be granted again — reopen this workspace from Settings.`);
    this.name = "PermissionRequiredError";
  }
}

async function ensurePermission(handle: FileSystemDirectoryHandle): Promise<void> {
  const opts = { mode: "readwrite" as const };
  if ((await handle.queryPermission(opts)) === "granted") return;
  // `requestPermission` only actually prompts under a user gesture; this
  // path runs from `Workspace.tsx`'s mount effect, which isn't one, so
  // trying it is really just a formality before surfacing
  // `PermissionRequiredError` — the real re-grant happens through
  // Settings' "Choose…" button, a real click.
  if ((await handle.requestPermission(opts)) === "granted") return;
  throw new PermissionRequiredError(handle.name);
}

export class WasmDocBackend implements DocBackend {
  private doc: WebDocument | null = null;
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private onRemote: ((bytes: Uint8Array) => void) | null = null;

  async open(workspaceId: string): Promise<Uint8Array> {
    const handle = await getWorkspaceHandle(workspaceId);
    if (!handle) {
      throw new Error(`No stored folder handle for workspace "${workspaceId}" — pick it again from Settings.`);
    }
    await ensurePermission(handle);

    const { WebDocument } = await import("../../../src-web/pkg/dendroid_web");
    const doc = await WebDocument.open(handle);
    this.doc = doc;

    this.pollHandle = setInterval(() => {
      void doc.pollExternal().then((updateB64) => {
        if (updateB64) this.onRemote?.(base64ToBytes(updateB64));
      });
    }, POLL_INTERVAL_MS);

    return base64ToBytes(doc.snapshotForBootstrap());
  }

  async importUpdate(bytes: Uint8Array): Promise<void> {
    if (!this.doc) throw new Error("[wasm] importUpdate called before open()");
    await this.doc.importUpdate(bytesToBase64(bytes));
  }

  onRemoteUpdate(callback: (bytes: Uint8Array) => void): void {
    this.onRemote = callback;
  }

  async history(): Promise<HistoryEntryDto[]> {
    if (!this.doc) throw new Error("[wasm] history called before open()");
    return this.doc.history() as HistoryEntryDto[];
  }

  /** Unlike Tauri (a separate broadcast event), the wasm binding just
   * hands the resulting delta straight back — forward it to `onRemote`
   * ourselves, the same way `pollExternal`'s interval loop already does. */
  async revertTo(token: string): Promise<void> {
    if (!this.doc) throw new Error("[wasm] revertTo called before open()");
    await this.doc.revertTo(token);
    const updateB64 = this.doc.exportUpdatesForFrontend();
    if (updateB64) this.onRemote?.(base64ToBytes(updateB64));
  }

  dispose(): void {
    if (this.pollHandle !== null) clearInterval(this.pollHandle);
    this.pollHandle = null;
    this.doc?.free();
    this.doc = null;
    this.onRemote = null;
  }

  encryptionStatus(): Promise<EncryptionStatusDto> {
    if (!this.doc) throw new Error("[wasm] encryptionStatus called before open()");
    return Promise.resolve(this.doc.encryptionStatus() as EncryptionStatusDto);
  }

  async generateEncryptionKey(): Promise<GeneratedEncryptionKey> {
    if (!this.doc) throw new Error("[wasm] generateEncryptionKey called before open()");
    return (await this.doc.generateEncryptionKey()) as GeneratedEncryptionKey;
  }

  async setEncryptionKey(keyText: string): Promise<EncryptionStatusDto> {
    if (!this.doc) throw new Error("[wasm] setEncryptionKey called before open()");
    return (await this.doc.setEncryptionKey(keyText)) as EncryptionStatusDto;
  }

  async removeEncryptionKey(): Promise<void> {
    if (!this.doc) throw new Error("[wasm] removeEncryptionKey called before open()");
    this.doc.removeEncryptionKey();
  }
}
