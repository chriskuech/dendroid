// Bridges the Automations tab (components/automations/*) to the Rust-side
// background engine (src-tauri/src/automation.rs) that actually fires cron
// schedules and watches for database row changes — see that module's doc
// comment for the engine itself. lib/skills.ts and lib/automations.ts call
// `syncAutomationsEngine` after every mutation so the engine's own copy
// never drifts from what's on screen; `Workspace.tsx` calls
// `setAutomationsCwd` whenever the open workspace (or the configured agent
// command) changes, since the engine needs a working directory to spawn the
// agent in and dendroid only ever has one active workspace at a time (same
// simplification `lib/threads.ts` already makes for `ChatThread`).
//
// A no-op outside Tauri, same guard every other Tauri-only bridge in this
// app uses (lib/acp.ts, lib/mcp.ts, lib/db.ts) — there's nothing able to
// run a background engine in the web/wasm preview build.

import { loadAppSettings, loadAutomations, loadSkills } from "./settingsStore";
import type { Automation, AutomationRun, AutomationRunSummary, TriggerEvent } from "./types";
import { DEFAULT_SETTINGS } from "./types";

function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function splitArgs(args: string): string[] {
  return args.split(/\s+/).filter(Boolean);
}

/** Mirrors `src-tauri/src/automation.rs`'s `AutomationSyncDto` — a fully
 * resolved snapshot (skill instructions inlined, agent command/args
 * inlined) rather than ids the engine would have to look anything else up
 * by, since the engine has no other access to dendroid's settings store. */
interface AutomationSyncDto {
  id: string;
  name: string;
  cron: string | null;
  data: { databaseId: string; table: string; events: TriggerEvent[] } | null;
  skillName: string;
  skillInstructions: string;
  agentCommand: string;
  agentArgs: string[];
}

// The engine needs a working directory to spawn the configured agent in,
// but automations themselves aren't workspace-scoped (see this module's
// doc comment) — so it's tracked here as its own bit of state, set by
// whichever `Workspace` is currently open, rather than threaded through
// every automation/skill CRUD call.
let currentCwd: string | null = null;

/** Called by `Workspace.tsx` when the open workspace's root path changes
 * (including to `null` on close) — triggers an immediate resync so the
 * engine picks up the new cwd (and, on first open, the automations/skills
 * that were configured before this workspace was opened) without waiting
 * for the next unrelated edit. */
export function setAutomationsCwd(cwd: string | null): void {
  currentCwd = cwd;
  void syncAutomationsEngine();
}

/** Pushes the current skills/automations/agent-settings state to the
 * engine as one resolved snapshot — see `AutomationSyncDto`. Disabled
 * automations and ones missing their referenced skill are left out
 * entirely rather than sent with empty instructions, so the engine never
 * has to re-derive "should this actually run" itself. No-op until a
 * workspace has set a cwd (`setAutomationsCwd`) — nothing to spawn the
 * agent in yet. */
export async function syncAutomationsEngine(): Promise<void> {
  if (!hasTauri() || !currentCwd) return;
  try {
    const [automations, skills, appSettings] = await Promise.all([loadAutomations(), loadSkills(), loadAppSettings()]);
    const agent = appSettings?.agent ?? DEFAULT_SETTINGS.agent;
    const dtos: AutomationSyncDto[] = automations
      .filter((a) => a.enabled && (a.cron || a.data))
      .map((a) => {
        const skill = skills.find((s) => s.id === a.skillId);
        return {
          id: a.id,
          name: a.name,
          cron: a.cron ? cronToExpression(a) : null,
          data: a.data ? { databaseId: a.data.databaseId, table: a.data.table, events: a.data.events } : null,
          skillName: skill?.name ?? "",
          skillInstructions: skill?.instructions ?? "",
          agentCommand: agent.command,
          agentArgs: splitArgs(agent.args),
        };
      })
      .filter((dto) => dto.skillInstructions.trim().length > 0);
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("automations_sync", { cwd: currentCwd, automations: dtos });
  } catch (err) {
    console.error("[automations] failed to sync engine", err);
  }
}

// Kept local rather than importing lib/automations.ts's
// `cronScheduleToExpression` to avoid a require cycle (lib/automations.ts
// imports this module for its own post-mutate sync call); trivial enough
// to duplicate the one-line compile step.
function cronToExpression(automation: Automation): string {
  const cron = automation.cron;
  if (!cron) return "";
  if (cron.frequency === "hourly") return `${cron.minute} * * * *`;
  if (cron.frequency === "daily") return `${cron.minute} ${cron.hour} * * *`;
  return `${cron.minute} ${cron.hour} * * ${cron.weekday}`;
}

export class AutomationsUnavailableError extends Error {
  constructor() {
    super("Automations are only available in the desktop app");
    this.name = "AutomationsUnavailableError";
  }
}

/** Fires `automationId` immediately, the same way the engine would on its
 * own schedule/data watch — Automations tab's "Run now". Resolves once the
 * agent's turn fully ends, and its result is persisted exactly like an
 * automatic fire, so it shows up in `listAutomationRuns` afterward.
 * `simulateEvent` stands in for a real row change on a data-triggered
 * automation, mirroring `ThreadChat.tsx`'s own simulate-event picker for
 * cron/trigger threads. */
export async function runAutomationNow(automationId: string, simulateEvent?: TriggerEvent): Promise<void> {
  if (!hasTauri()) throw new AutomationsUnavailableError();
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("automation_run_now", { automationId, simulateEvent: simulateEvent ?? null });
}

/** Every run this automation has ever fired, most recent first — what
 * `AutomationRunsView` lists ("the ACP chats initiated by the trigger"). */
export async function listAutomationRuns(automationId: string): Promise<AutomationRunSummary[]> {
  if (!hasTauri()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AutomationRunSummary[]>("automation_runs_list", { automationId });
}

/** One run's full transcript — see `AutomationRun.updates`. */
export async function getAutomationRun(automationId: string, runId: string): Promise<AutomationRun> {
  if (!hasTauri()) throw new AutomationsUnavailableError();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AutomationRun>("automation_run_get", { automationId, runId });
}

/** Fired by the Rust side whenever a run finishes (or fails) — see
 * `src-tauri/src/automation.rs`'s `emit_run_event`. Payload is just the ids
 * needed to know what to re-fetch, same "no delta payload, just refetch"
 * convention `lib/db.ts`'s `onDatabasesChanged` already uses. */
export function onAutomationRun(handler: (event: { automationId: string; runId: string }) => void): () => void {
  if (!hasTauri()) return () => {};
  let unlisten: (() => void) | undefined;
  let cancelled = false;
  void import("@tauri-apps/api/event").then(({ listen }) => {
    if (cancelled) return;
    void listen<{ automationId: string; runId: string }>("automations://run", (e) => handler(e.payload)).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
