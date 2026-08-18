// Shared shape between `tauri.ts` and `web.ts`: both back every setting
// except the encryption key with a plain get/set/save `KVStore` (a Tauri
// `Store` or an in-memory `Map`), and differ only in which one and in how
// the encryption key text itself is stored — so that's the only piece
// factored out as a strategy rather than the whole adapter.

import type { AppSettings, Automation, ChatThread, Skill, Workspace } from "../../lib/types";
import type { SettingsStoreAdapter } from "./types";

const WORKSPACE_KEY = "workspace";
const APP_SETTINGS_KEY = "appSettings";
const THREADS_KEY = "chatThreads";
const SKILLS_KEY = "skills";
const AUTOMATIONS_KEY = "automations";

export interface KVStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
}

/** Where the encryption key's textual form actually lives — the OS
 * keychain under Tauri, or the same `KVStore` everything else here uses
 * outside it (see `web.ts`). Kept separate from `KVStore` itself since
 * under Tauri this is backed by IPC calls to a different plugin entirely,
 * not the `Store` the rest of this adapter uses. */
export interface EncryptionKeyStore {
  load(): Promise<string | null>;
  save(keyText: string): Promise<void>;
  clear(): Promise<void>;
}

export function createKvBackedSettingsStore(store: KVStore, encryptionKey: EncryptionKeyStore): SettingsStoreAdapter {
  return {
    async loadWorkspace() {
      return (await store.get<Workspace>(WORKSPACE_KEY)) ?? null;
    },
    async saveWorkspace(workspace) {
      await store.set(WORKSPACE_KEY, workspace);
      await store.save();
    },

    async loadAppSettings() {
      return (await store.get<AppSettings>(APP_SETTINGS_KEY)) ?? null;
    },
    async saveAppSettings(settings) {
      await store.set(APP_SETTINGS_KEY, settings);
      await store.save();
    },

    async loadThreads() {
      return (await store.get<ChatThread[]>(THREADS_KEY)) ?? [];
    },
    async saveThreads(threads) {
      await store.set(THREADS_KEY, threads);
      await store.save();
    },

    async loadSkills() {
      return (await store.get<Skill[]>(SKILLS_KEY)) ?? [];
    },
    async saveSkills(skills) {
      await store.set(SKILLS_KEY, skills);
      await store.save();
    },

    async loadAutomations() {
      return (await store.get<Automation[]>(AUTOMATIONS_KEY)) ?? [];
    },
    async saveAutomations(automations) {
      await store.set(AUTOMATIONS_KEY, automations);
      await store.save();
    },

    loadEncryptionKeyText: () => encryptionKey.load(),
    saveEncryptionKeyText: (keyText) => encryptionKey.save(keyText),
    clearEncryptionKeyText: () => encryptionKey.clear(),
  };
}
