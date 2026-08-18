// Thin wrapper around @tauri-apps/plugin-store. Settings persist to
// `settings.json` in the OS app-config dir (e.g. ~/Library/Application
// Support/dev.kuech.dendroid on macOS), managed by the Rust-side store
// plugin registered in src-tauri/src/lib.rs.
//
// The encryption key's textual form is the one exception — it goes through
// the OS keychain instead (`src-tauri/src/keychain.rs`, via IPC), not this
// plaintext store.

import type { KVStore } from "./kvSettingsStore";
import { createKvBackedSettingsStore } from "./kvSettingsStore";
import type { SettingsStoreAdapter } from "./types";

const STORE_FILE = "settings.json";

let storePromise: Promise<KVStore> | null = null;

function getStore(): Promise<KVStore> {
  if (!storePromise) {
    storePromise = import("@tauri-apps/plugin-store").then(({ Store }) => Store.load(STORE_FILE));
  }
  return storePromise;
}

export function createTauriSettingsStore(): SettingsStoreAdapter {
  const store: KVStore = {
    get: (key) => getStore().then((s) => s.get(key)),
    set: (key, value) => getStore().then((s) => s.set(key, value)),
    save: () => getStore().then((s) => s.save()),
  };

  return createKvBackedSettingsStore(store, {
    async load() {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<string | null>("keychain_get_encryption_key");
    },
    async save(keyText) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("keychain_set_encryption_key", { keyText });
    },
    async clear() {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("keychain_delete_encryption_key");
    },
  });
}
