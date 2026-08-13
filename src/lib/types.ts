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
  /** Names of skills (MCP tools — see `lib/mcp.ts`'s `listMcpSkills`) the
   * "Skills" settings section has turned off. Enforced server-side, in
   * `src-mcp`'s `ToolRouter` (a disabled skill is hidden from `tools/list`
   * and rejected if called anyway) — not filtered here, so this is just
   * the list of names to disable, not a cache of anything richer. Absent
   * names are enabled; there's no "unknown skill" state to represent. */
  disabledSkills: string[];
}

/** Configures the agent the chat drawer spawns — see `lib/acp.ts` and
 * `components/agent/AgentPanel.tsx`. Any Agent Client Protocol (ACP) agent
 * works: `command` is launched as a subprocess and spoken to over stdio, no
 * different from pointing an ACP-aware editor at the same binary. Unlike
 * `McpSettings` there's no "enabled" toggle — an empty `command` alone
 * means "not configured yet" (the drawer shows a prompt to set one). */
export interface AgentSettings {
  /** Path to (or bare name on `PATH` of) an ACP-speaking agent binary. */
  command: string;
  /** Extra arguments passed to `command`, as one space-separated string
   * (split on whitespace before reaching the Rust side — see
   * `lib/acp.ts`'s `startAgent`), so the settings field can just be a
   * plain text input rather than a dynamic list. */
  args: string;
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
  agent: AgentSettings;
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
    disabledSkills: [],
  },
  agent: {
    command: "",
    args: "",
  },
};

export const DEPTH_MIN = 1;
export const DEPTH_MAX = 9;
