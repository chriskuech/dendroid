// Thin wrapper around @tauri-apps/plugin-store. Settings persist to
// `settings.json` in the OS app-config dir (e.g. ~/Library/Application
// Support/dev.kuech.dendroid on macOS), managed by the Rust-side store
// plugin registered in src-tauri/src/lib.rs.
//
// Falls back to an in-memory store when the Tauri IPC bridge isn't present
// (e.g. `vite dev` opened directly in a browser instead of `tauri dev`), so
// the UI stays inspectable without a native backend — but nothing persists
// across reloads in that mode.

import type { AppSettings, Workspace } from "./types";

const STORE_FILE = "settings.json";
const WORKSPACE_KEY = "workspace";
const APP_SETTINGS_KEY = "appSettings";

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
