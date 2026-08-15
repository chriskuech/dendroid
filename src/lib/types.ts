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

/** Which preset (if any) filled in `AgentSettings.command`/`args` — see
 * `lib/agentProviders.ts`'s `AGENT_PROVIDERS`. Purely a Settings UI concern:
 * `lib/acp.ts`'s `startAgent` only ever looks at `command`/`args`
 * themselves, so this doesn't reach the Rust side at all. "custom" is the
 * "add settings directly" option — `command`/`args` are user-editable;
 * every other kind locks them to that provider's preset. */
export type AgentProvider = "none" | "ollama" | "claudeCode" | "custom";

/** Configures the agent the chat drawer spawns — see `lib/acp.ts` and
 * `components/agent/AgentPanel.tsx`. Any Agent Client Protocol (ACP) agent
 * works: `command` is launched as a subprocess and spoken to over stdio, no
 * different from pointing an ACP-aware editor at the same binary. Unlike
 * `McpSettings` there's no "enabled" toggle — an empty `command` alone
 * means "not configured yet" (the drawer shows a prompt to set one), which
 * is exactly what the "none" provider resolves to. */
export interface AgentSettings {
  provider: AgentProvider;
  /** Path to (or bare name on `PATH` of) an ACP-speaking agent binary. */
  command: string;
  /** Extra arguments passed to `command`, as one space-separated string
   * (split on whitespace before reaching the Rust side — see
   * `lib/acp.ts`'s `startAgent`), so the settings field can just be a
   * plain text input rather than a dynamic list. */
  args: string;
}

/** Which of the three things can start a chat thread with the ACP agent —
 * see `lib/threads.ts` and `components/agent/AgentPanel.tsx`. */
export type ThreadKind = "human" | "cron" | "trigger";

/** Row-change kinds a "trigger" thread can fire on, mirroring SQL's own
 * INSERT/UPDATE/DELETE vocabulary. */
export type TriggerEvent = "insert" | "update" | "delete";

/** A "cron" thread's config: when to run, and what to ask the agent to do
 * each time. */
export interface CronThreadConfig {
  /** Standard 5-field cron expression (minute hour day-of-month month
   * day-of-week), e.g. `"0 9 * * *"` for daily at 9am. Dendroid doesn't run
   * a background scheduler that reads this yet — see `ChatThread`'s doc
   * comment — so for now it's descriptive metadata plus what `runThreadNow`
   * sends verbatim when the thread is run manually. */
  schedule: string;
  /** The prompt sent to the agent each time this thread runs. Framed as
   * "skill" (matching the vocabulary Settings' "Skills" section already
   * uses for MCP tools) rather than "prompt", since it names a specific
   * task the agent repeats rather than a one-off message. */
  skill: string;
}

/** A "trigger" thread's config: which table to watch, which row-change
 * kinds fire it, and what to ask the agent to do each time. */
export interface TriggerThreadConfig {
  /** Which database (see `lib/db.ts`'s `DatabaseDto`) and table within it
   * this thread watches. */
  databaseId: string;
  table: string;
  /** Which row-change kinds fire this thread — at least one. */
  events: TriggerEvent[];
  /** The prompt sent to the agent on each fire; the triggering row change
   * is appended to it as event JSON — see `lib/threads.ts`'s
   * `buildTriggerEventJson`. */
  skill: string;
}

/** One saved chat thread: a persisted identity + config for a conversation
 * with the ACP agent (`lib/acp.ts`), independent of any particular
 * window's live connection to it (`components/agent/AgentPanel.tsx` owns
 * that). See `lib/threads.ts` for the CRUD around this list.
 *
 * Only "human" threads are message-driven the way the chat drawer always
 * used to be — a person types, the agent replies. "cron" and "trigger"
 * threads instead describe *when* dendroid should send their `skill` to
 * the agent on the thread's behalf: a schedule, or a database row change.
 * Dendroid doesn't yet run a background scheduler or hook into SQLite's own
 * row-level triggers to fire these automatically; this type and the UX
 * built on it (creating/configuring/deleting threads) are what an
 * automatic-firing feature would be layered onto later. Until then, each
 * thread's chat view has a manual "Run now" standing in for that — see
 * `lib/threads.ts`'s `buildTriggerEventJson`. */
export interface ChatThread {
  id: string;
  kind: ThreadKind;
  title: string;
  createdAt: string;
  cron?: CronThreadConfig;
  trigger?: TriggerThreadConfig;
}

/** A reusable, user-authored prompt (Automations tab's "Skills" section) —
 * distinct from `McpSettings.disabledSkills` (which toggles *MCP tool*
 * skills a connected agent can call, see `lib/mcp.ts`'s `listMcpSkills`).
 * This kind of skill is instead a saved block of instructions an
 * `Automation` sends the agent verbatim each time it fires, the same role
 * `CronThreadConfig.skill`/`TriggerThreadConfig.skill` used to play as a
 * one-off freeform string before automations grew a dedicated, reusable
 * list of these to pick from. */
export interface Skill {
  id: string;
  name: string;
  description: string;
  /** Sent to the agent as its prompt each time an `Automation` referencing
   * this skill fires — the trigger's own event JSON (see
   * `lib/threads.ts`'s `buildTriggerEventJson`) is appended after it for
   * data-triggered fires. */
  instructions: string;
  createdAt: string;
}

/** A friendlier, form-driven alternative to typing a raw cron string —
 * compiles to one via `lib/automations.ts`'s `cronScheduleToExpression`.
 * Only the fields a given `frequency` actually uses are read when
 * compiling (e.g. "hourly" ignores `hour`), but all four are always kept
 * around so switching frequency in the form doesn't lose whatever the
 * other fields were set to. */
export type CronFrequency = "hourly" | "daily" | "weekly";

export interface CronSchedule {
  frequency: CronFrequency;
  /** Minute of the hour (0-59) — every frequency uses this. */
  minute: number;
  /** Hour of the day (0-23) — "daily"/"weekly" only. */
  hour: number;
  /** Day of the week (0 = Sunday .. 6 = Saturday) — "weekly" only. */
  weekday: number;
}

/** An `Automation`'s data-watch half — which database/table/row-change
 * kinds fire it. Same shape `TriggerThreadConfig` already used, split out
 * so `Automation` can carry it alongside (rather than instead of) a cron
 * schedule — see `Automation`'s doc comment. */
export interface AutomationDataTrigger {
  databaseId: string;
  table: string;
  events: TriggerEvent[];
}

/** One row change (or best-effort approximation of one — see
 * `src-tauri/src/automation.rs`'s `detect_write`) that fired an
 * `AutomationRun`. */
export interface AutomationEvent {
  database: string;
  table: string;
  event: TriggerEvent;
  /** Bound statement params, positionally — the closest thing to "the
   * row" the engine has without a full round trip back to the table (see
   * `detect_write`'s doc comment for why this is best-effort). */
  params?: unknown[];
  firedAt: string;
}

/** A saved automation (the Automations tab's "Triggers" section): a name,
 * a `Skill` to run, and *when* to run it — a cron schedule, a database
 * watch, or both at once (whichever is set is checked; if both are set,
 * either firing condition fires it independently). Unlike a "cron"/
 * "trigger" `ChatThread` (see that type's doc comment), this one *is*
 * actually driven automatically — `src-tauri/src/automation.rs`'s
 * background engine, kept in sync with this list via `lib/automations.ts`'s
 * `syncAutomationsEngine`. Each firing is recorded as a standalone
 * `AutomationRunSummary`/`AutomationRun` (its own ACP chat), rather than
 * appending to one long-lived conversation — see `AutomationRunSummary`'s
 * doc comment for why. */
export interface Automation {
  id: string;
  name: string;
  skillId: string;
  cron?: CronSchedule;
  data?: AutomationDataTrigger;
  /** A disabled automation stays configured but the engine skips it —
   * cheaper than deleting-and-recreating for "pause this for a while". */
  enabled: boolean;
  createdAt: string;
}

/** How an `AutomationRun` was started — mirrors
 * `src-tauri/src/automation.rs`'s `RunReason`. `"manual"` is the
 * Automations tab's own "Run now" (distinct from a `ChatThread`'s
 * identically-named affordance — this one persists like any other run). */
export type AutomationRunReason = "cron" | "data" | "manual";

export type AutomationRunStatus = "running" | "done" | "error";

/** One row of `automation_runs_list` — everything a run list needs to
 * render without paying for `updates`' full transcript. Each firing gets
 * its own run (and so its own spawned agent process/session) rather than
 * reusing one — the "ACP chats initiated by the trigger" the Automations
 * tab drills into are genuinely separate conversations, one per fire, the
 * same way a cron job's separate invocations don't share a terminal
 * session. */
export interface AutomationRunSummary {
  id: string;
  automationId: string;
  automationName: string;
  reason: AutomationRunReason;
  event?: AutomationEvent;
  firedAt: string;
  status: AutomationRunStatus;
  error?: string;
  stopReason?: string;
}

/** Full detail for one run — `automation_run_get`'s response. `updates` is
 * every raw `session/update` payload the agent streamed, in arrival order;
 * `components/agent/timelineUpdates.ts`'s `applyUpdate` folds them into the same
 * `TimelineItem[]` shape a live thread's chat renders, so
 * `AutomationRunChat.tsx` can reuse `Timeline.tsx` unchanged. */
export interface AutomationRun extends AutomationRunSummary {
  prompt: string;
  updates: unknown[];
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
    provider: "none",
    command: "",
    args: "",
  },
};

export const DEPTH_MIN = 1;
export const DEPTH_MAX = 9;
