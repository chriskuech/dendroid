// Talks to the Tauri IPC commands in `src-tauri/src/commands.rs`, which
// delegate to `dendroid_core::native::NativeDocument` — see that command
// module's doc comment for the `crdt://update` broadcast contract this
// mirrors.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { base64ToBytes, bytesToBase64 } from "../../lib/crdt/base64";
import type { EncryptionStatusDto, GeneratedEncryptionKey } from "../../lib/crdt/encryption";
import type { HistoryEntryDto } from "../../lib/crdt/history";
import type { DocBackend } from "./types";

const UPDATE_EVENT = "crdt://update";

interface WorkspaceOpenResult {
  snapshotB64: string;
}

interface UpdatePayload {
  updateB64: string;
}

export class TauriDocBackend implements DocBackend {
  private unlisten: UnlistenFn | null = null;

  async open(workspaceRoot: string): Promise<Uint8Array> {
    const result = await invoke<WorkspaceOpenResult>("workspace_open", { root: workspaceRoot });
    return base64ToBytes(result.snapshotB64);
  }

  async importUpdate(bytes: Uint8Array): Promise<void> {
    await invoke("doc_import_update", { updateB64: bytesToBase64(bytes) });
  }

  onRemoteUpdate(callback: (bytes: Uint8Array) => void): void {
    void listen<UpdatePayload>(UPDATE_EVENT, (event) => callback(base64ToBytes(event.payload.updateB64))).then((unlisten) => {
      this.unlisten = unlisten;
    });
  }

  history(): Promise<HistoryEntryDto[]> {
    return invoke<HistoryEntryDto[]>("doc_history");
  }

  async revertTo(token: string): Promise<void> {
    await invoke("doc_revert_to", { token });
  }

  dispose(): void {
    this.unlisten?.();
    this.unlisten = null;
  }

  encryptionStatus(): Promise<EncryptionStatusDto> {
    return invoke<EncryptionStatusDto>("encryption_status");
  }

  generateEncryptionKey(): Promise<GeneratedEncryptionKey> {
    return invoke<GeneratedEncryptionKey>("encryption_generate_key");
  }

  setEncryptionKey(keyText: string): Promise<EncryptionStatusDto> {
    return invoke<EncryptionStatusDto>("encryption_set_key", { keyText });
  }

  removeEncryptionKey(): Promise<void> {
    return invoke("encryption_remove_key");
  }
}
