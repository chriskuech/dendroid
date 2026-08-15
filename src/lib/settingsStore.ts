// Thin wrapper around @tauri-apps/plugin-store. Settings persist to
// `settings.json` in the OS app-config dir (e.g. ~/Library/Application
// Support/dev.kuech.dendroid on macOS), managed by the Rust-side store
// plugin registered in src-tauri/src/lib.rs.
//
// Falls back to an in-memory store when the Tauri IPC bridge isn't present
// (e.g. `vite dev` opened directly in a browser instead of `tauri dev`), so
// the UI stays inspectable without a native backend — but nothing persists
// across reloads in that mode.
//
// One exception to all of the above: the encryption key's textual form
// (`loadEncryptionKeyText`/`saveEncryptionKeyText`/`clearEncryptionKeyText`)
// doesn't go through this plaintext store under Tauri — it goes through
// the OS keychain instead (`src-tauri/src/keychain.rs`, via IPC), and only
// falls back to this file's usual `settings.json`/in-memory store outside
// Tauri, where there's no keychain to ask.

import type { AppSettings, Automation, ChatThread, Skill, Workspace } from "./types";

const STORE_FILE = "settings.json";
const WORKSPACE_KEY = "workspace";
const APP_SETTINGS_KEY = "appSettings";
const THREADS_KEY = "chatThreads";
const SKILLS_KEY = "skills";
const AUTOMATIONS_KEY = "automations";
/** Fallback slot for the encryption key's textual form, used only when
 * there's no OS keychain to ask (see `loadEncryptionKeyText` and friends,
 * below) — a plain browser tab/web build has no keychain equivalent, so it
 * falls back to this same plaintext `settings.json` store like everything
 * else here, which in practice means the in-memory-only `MemoryStore`
 * (nothing persists across reloads there regardless). Under Tauri, this
 * key is never written to — `keychain_*` (`src-tauri/src/keychain.rs`) is
 * the real, persisted store there. */
const ENCRYPTION_KEY_FALLBACK_KEY = "encryptionKeyText";

interface KVStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
}

function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

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

let storePromise: Promise<KVStore> | null = null;

function getStore(): Promise<KVStore> {
  if (!storePromise) {
    storePromise = hasTauri()
      ? import("@tauri-apps/plugin-store").then(({ Store }) => Store.load(STORE_FILE))
      : (console.warn(
          "[settingsStore] Tauri bridge not detected — using an in-memory store. Settings will not persist.",
        ),
        Promise.resolve(new MemoryStore()));
  }
  return storePromise;
}

export async function loadWorkspace(): Promise<Workspace | null> {
  const store = await getStore();
  return (await store.get<Workspace>(WORKSPACE_KEY)) ?? null;
}

export async function saveWorkspace(workspace: Workspace): Promise<void> {
  const store = await getStore();
  await store.set(WORKSPACE_KEY, workspace);
  await store.save();
}

export async function loadAppSettings(): Promise<Partial<AppSettings> | null> {
  const store = await getStore();
  return (await store.get<AppSettings>(APP_SETTINGS_KEY)) ?? null;
}

export async function saveAppSettings(settings: AppSettings): Promise<void> {
  const store = await getStore();
  await store.set(APP_SETTINGS_KEY, settings);
  await store.save();
}

/** The full list of saved chat threads (`lib/types.ts`'s `ChatThread`) —
 * see `lib/threads.ts` for the CRUD built on top of this. One flat list
 * rather than partitioned per workspace, same simplification `workspace`/
 * `appSettings` above already make: dendroid only ever has one active
 * workspace at a time, so there's nowhere else for "which workspace" to
 * live yet. Defaults to `[]` rather than `null` (unlike `loadWorkspace`)
 * since callers always want a list to render, never a "nothing saved yet"
 * branch of their own. */
export async function loadThreads(): Promise<ChatThread[]> {
  const store = await getStore();
  return (await store.get<ChatThread[]>(THREADS_KEY)) ?? [];
}

export async function saveThreads(threads: ChatThread[]): Promise<void> {
  const store = await getStore();
  await store.set(THREADS_KEY, threads);
  await store.save();
}

/** The full list of saved skills (`lib/types.ts`'s `Skill`) — see
 * `lib/skills.ts` for the CRUD built on top of this. Same "one flat list,
 * not workspace-scoped" simplification `loadThreads`/`saveThreads` already
 * make. Defaults to `[]`, same reasoning as `loadThreads`. */
export async function loadSkills(): Promise<Skill[]> {
  const store = await getStore();
  return (await store.get<Skill[]>(SKILLS_KEY)) ?? [];
}

export async function saveSkills(skills: Skill[]): Promise<void> {
  const store = await getStore();
  await store.set(SKILLS_KEY, skills);
  await store.save();
}

/** The full list of saved automations (`lib/types.ts`'s `Automation`) —
 * see `lib/automations.ts` for the CRUD built on top of this, and
 * `syncAutomationsEngine` for how this list actually reaches the Rust-side
 * background engine that fires them. */
export async function loadAutomations(): Promise<Automation[]> {
  const store = await getStore();
  return (await store.get<Automation[]>(AUTOMATIONS_KEY)) ?? [];
}

export async function saveAutomations(automations: Automation[]): Promise<void> {
  const store = await getStore();
  await store.set(AUTOMATIONS_KEY, automations);
  await store.save();
}

/** This device's persisted encryption key text, if one's been set — under
 * Tauri, backed by the OS keychain (macOS Keychain / Windows Credential
 * Manager / Linux Secret Service — see `src-tauri/src/keychain.rs`) rather
 * than the plaintext `settings.json` every other setting here uses:
 * encryption key material is exactly the kind of secret an OS keychain
 * exists for, unlike e.g. `AppSettings` or which folder a workspace lives
 * in. `null` means encryption has never been enabled on this device (or
 * its key was removed, via `clearEncryptionKeyText`). */
export async function loadEncryptionKeyText(): Promise<string | null> {
  if (hasTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string | null>("keychain_get_encryption_key");
  }
  const store = await getStore();
  return (await store.get<string>(ENCRYPTION_KEY_FALLBACK_KEY)) ?? null;
}

export async function saveEncryptionKeyText(keyText: string): Promise<void> {
  if (hasTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("keychain_set_encryption_key", { keyText });
    return;
  }
  const store = await getStore();
  await store.set(ENCRYPTION_KEY_FALLBACK_KEY, keyText);
  await store.save();
}

/** Called from Settings' "Remove key" danger-zone action, alongside
 * `DocBackend.removeEncryptionKey` — without this, the next app start
 * would just re-supply the removed key right back (`lib/crdt/document.ts`'s
 * `open`). */
export async function clearEncryptionKeyText(): Promise<void> {
  if (hasTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("keychain_delete_encryption_key");
    return;
  }
  const store = await getStore();
  await store.set(ENCRYPTION_KEY_FALLBACK_KEY, null);
  await store.save();
}
