// Thin wrapper around @tauri-apps/plugin-store. Settings persist to
// `settings.json` in the OS app-config dir (e.g. ~/Library/Application
// Support/dev.kuech.dendroid on macOS), managed by the Rust-side store
// plugin registered in src-tauri/src/lib.rs.
//
// Falls back to an in-memory store when the Tauri IPC bridge isn't present
// (e.g. `vite dev` opened directly in a browser instead of `tauri dev`), so
// the UI stays inspectable without a native backend — but nothing persists
// across reloads in that mode.

import type { AppSettings, ChatThread, Workspace } from "./types";

const STORE_FILE = "settings.json";
const WORKSPACE_KEY = "workspace";
const APP_SETTINGS_KEY = "appSettings";
const THREADS_KEY = "chatThreads";
/** This device's encryption key, in its textual form (see
 * `dendroid_core::crypto::EncryptionKey::to_text`) — kept separate from
 * `APP_SETTINGS_KEY` rather than folded into `AppSettings` so ordinary
 * settings code (`updateSettings`, which round-trips the *whole* object on
 * every change) never has a reason to touch it. `lib/crdt/document.ts`
 * reads this once on `open()` to re-supply the key to the backend (see
 * `dendroid_core::doc::DendroidDocument::set_encryption_key`'s doc comment
 * on why that's idempotent) and writes it once, right after a key is
 * first created or paired. A known simplification, same as every other
 * setting this store holds: this is the OS-level app-config store
 * (`@tauri-apps/plugin-store`), not an OS keychain — see the whitepaper's
 * "stored securely internally" for the aspiration this doesn't yet meet. */
const ENCRYPTION_KEY_KEY = "encryptionKeyText";

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

/** This device's persisted encryption key text, if one's been set — see
 * `ENCRYPTION_KEY_KEY`. `null` means encryption has never been enabled on
 * this device (or its key was removed, via `clearEncryptionKeyText`). */
export async function loadEncryptionKeyText(): Promise<string | null> {
  const store = await getStore();
  return (await store.get<string>(ENCRYPTION_KEY_KEY)) ?? null;
}

export async function saveEncryptionKeyText(keyText: string): Promise<void> {
  const store = await getStore();
  await store.set(ENCRYPTION_KEY_KEY, keyText);
  await store.save();
}

/** Called from Settings' "Remove key" danger-zone action, alongside
 * `DocBackend.removeEncryptionKey` — without this, the next app start
 * would just re-supply the removed key right back (`lib/crdt/document.ts`'s
 * `open`). */
export async function clearEncryptionKeyText(): Promise<void> {
  const store = await getStore();
  await store.set(ENCRYPTION_KEY_KEY, null);
  await store.save();
}
