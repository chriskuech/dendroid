// Settings persist to `settings.json` in the OS app-config dir under Tauri
// (see `tauri.ts`), or to an in-memory store in a plain web build (see
// `web.ts`) — nothing persists across reloads there, but the UI stays
// inspectable without a native backend.
//
// One exception to both: the encryption key's textual form
// (`loadEncryptionKeyText`/`saveEncryptionKeyText`/`clearEncryptionKeyText`)
// goes through the OS keychain under Tauri (`src-tauri/src/keychain.rs`,
// via IPC) rather than this plaintext store — see `tauri.ts`.

import type { AppSettings, Automation, ChatThread, Skill, Workspace } from "../../lib/types";

export interface SettingsStoreAdapter {
  loadWorkspace(): Promise<Workspace | null>;
  saveWorkspace(workspace: Workspace): Promise<void>;

  loadAppSettings(): Promise<Partial<AppSettings> | null>;
  saveAppSettings(settings: AppSettings): Promise<void>;

  /** The full list of saved chat threads (`lib/types.ts`'s `ChatThread`) —
   * see `ux/agent/threads.ts` for the CRUD built on top of this. One flat
   * list rather than partitioned per workspace, same simplification
   * `workspace`/`appSettings` above already make: dendroid only ever has
   * one active workspace at a time, so there's nowhere else for "which
   * workspace" to live yet. Defaults to `[]` rather than `null` (unlike
   * `loadWorkspace`) since callers always want a list to render, never a
   * "nothing saved yet" branch of their own. */
  loadThreads(): Promise<ChatThread[]>;
  saveThreads(threads: ChatThread[]): Promise<void>;

  /** The full list of saved skills (`lib/types.ts`'s `Skill`) — see
   * `ux/skills/skills.ts` for the CRUD built on top of this. Same
   * "one flat list, not workspace-scoped" simplification `loadThreads`/
   * `saveThreads` already make. Defaults to `[]`, same reasoning as
   * `loadThreads`. */
  loadSkills(): Promise<Skill[]>;
  saveSkills(skills: Skill[]): Promise<void>;

  /** The full list of saved automations (`lib/types.ts`'s `Automation`) —
   * see `ux/automations/automations.ts` for the CRUD built on top of this,
   * and `automationsEngine`'s `syncAutomationsEngine` for how this list
   * actually reaches the Rust-side background engine that fires them. */
  loadAutomations(): Promise<Automation[]>;
  saveAutomations(automations: Automation[]): Promise<void>;

  /** This device's persisted encryption key text, if one's been set —
   * under Tauri, backed by the OS keychain (macOS Keychain / Windows
   * Credential Manager / Linux Secret Service) rather than the plaintext
   * store every other setting here uses: encryption key material is
   * exactly the kind of secret an OS keychain exists for, unlike e.g.
   * `AppSettings` or which folder a workspace lives in. `null` means
   * encryption has never been enabled on this device (or its key was
   * removed, via `clearEncryptionKeyText`). */
  loadEncryptionKeyText(): Promise<string | null>;
  saveEncryptionKeyText(keyText: string): Promise<void>;

  /** Called from Settings' "Remove key" danger-zone action, alongside
   * `DocBackend.removeEncryptionKey` — without this, the next app start
   * would just re-supply the removed key right back
   * (`lib/crdt/document.ts`'s `open`). */
  clearEncryptionKeyText(): Promise<void>;
}
