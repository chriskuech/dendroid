// Domain types for workspace + app settings. Kept separate from the Rust
// core's CRDT/sync types (src-core) — these describe how the *app* stores
// its own configuration, not the note graph itself.

export type Aesthetic = "terminal" | "parchment";
export type ColorMode = "dark" | "light" | "system";
export type EditorMode = "zen" | "overlay";

/** Sync provider kinds. Only "file" is implemented; the rest are reserved
 * so the picker/registry has somewhere to grow into (see whitepaper.md). */
export type SyncProviderKind = "file" | "vault" | "cloud" | "git" | "github";

export interface FileSyncConfig {
  type: "file";
  /** Absolute path to the folder holding the transaction log. */
  rootPath: string;
}

// Future: VaultSyncConfig | CloudSyncConfig | GitSyncConfig | GitHubSyncConfig
export type SyncConfig = FileSyncConfig;

export interface Workspace {
  id: string;
  name: string;
  sync: SyncConfig;
  createdAt: string;
}

export interface McpSettings {
  enabled: boolean;
  host: string;
  port: number;
}

export interface AppSettings {
  aesthetic: Aesthetic;
  colorMode: ColorMode;
  editorMode: EditorMode;
  /** Levels of descendant headings rendered inline below the editor root. */
  descendantDepth: number;
  useSystemFont: boolean;
  /** Plays a soft typewriter key sound on every keypress within the
   * editor — see `lib/typewriterSound.ts` and Editor.tsx's `onKeyDownCapture`. */
  auralFeedback: boolean;
  mcp: McpSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  aesthetic: "terminal",
  colorMode: "dark",
  editorMode: "zen",
  descendantDepth: 3,
  useSystemFont: false,
  auralFeedback: false,
  mcp: {
    enabled: false,
    host: "127.0.0.1",
    port: 7717,
  },
};

export const DEPTH_MIN = 1;
export const DEPTH_MAX = 9;
