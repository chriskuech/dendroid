// No Tauri store plugin (and no OS keychain) to talk to in a plain web
// build — everything, including the encryption key's textual form, falls
// back to an in-memory `Map`. Nothing persists across reloads.

import { createKvBackedSettingsStore, type KVStore } from "./kvSettingsStore";
import type { SettingsStoreAdapter } from "./types";

/** Fallback slot for the encryption key's textual form — same `KVStore`
 * every other setting here uses, since there's no keychain equivalent to
 * ask outside Tauri. */
const ENCRYPTION_KEY_FALLBACK_KEY = "encryptionKeyText";

class MemoryStore implements KVStore {
  private data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
  async save(): Promise<void> {}
}

export function createWebSettingsStore(): SettingsStoreAdapter {
  console.warn("[settingsStore] Tauri bridge not detected — using an in-memory store. Settings will not persist.");
  const store = new MemoryStore();

  return createKvBackedSettingsStore(store, {
    async load() {
      return (await store.get<string>(ENCRYPTION_KEY_FALLBACK_KEY)) ?? null;
    },
    async save(keyText) {
      await store.set(ENCRYPTION_KEY_FALLBACK_KEY, keyText);
      await store.save();
    },
    async clear() {
      await store.set(ENCRYPTION_KEY_FALLBACK_KEY, null);
      await store.save();
    },
  });
}
