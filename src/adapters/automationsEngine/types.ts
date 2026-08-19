// Bridges the Automations tab (ux/automations/*) to the Rust-side
// background engine (src-tauri/src/automation.rs) that actually fires cron
// schedules and watches for database row changes — see that module's doc
// comment for the engine itself. ux/skills/skills.ts and
// ux/automations/automations.ts call `syncAutomationsEngine` after every
// mutation so the engine's own copy never drifts from what's on screen;
// `Workspace.tsx` calls `setAutomationsCwd` whenever the open workspace (or
// the configured agent command) changes, since the engine needs a working
// directory to spawn the agent in and dendroid only ever has one active
// workspace at a time (same simplification `ux/agent/threads.ts` already
// makes for `ChatThread`).
//
// No-op (or throwing) outside Tauri, same as `adapters/acp`/`adapters/mcp`
// — there's nothing able to run a background engine in the web/wasm
// preview build.

import type { AutomationRun, AutomationRunSummary, TriggerEvent } from "../../lib/types";

export class AutomationsUnavailableError extends Error {
  constructor() {
    super("Automations are only available in the desktop app");
    this.name = "AutomationsUnavailableError";
  }
}

export interface AutomationsEngineAdapter {
  /** Called by `Workspace.tsx` when the open workspace's root path
   * changes (including to `null` on close) — triggers an immediate resync
   * so the engine picks up the new cwd (and, on first open, the
   * automations/skills that were configured before this workspace was
   * opened) without waiting for the next unrelated edit. */
  setAutomationsCwd(cwd: string | null): void;

  /** Pushes the current skills/automations/agent-settings state to the
   * engine as one resolved snapshot. Disabled automations and ones
   * missing their referenced skill are left out entirely rather than sent
   * with empty instructions, so the engine never has to re-derive "should
   * this actually run" itself. No-op until a workspace has set a cwd
   * (`setAutomationsCwd`) — nothing to spawn the agent in yet. */
  syncAutomationsEngine(): Promise<void>;

  /** Fires `automationId` immediately, the same way the engine would on
   * its own schedule/data watch — Automations tab's "Run now". Resolves
   * once the agent's turn fully ends, and its result is persisted exactly
   * like an automatic fire, so it shows up in `listAutomationRuns`
   * afterward. `simulateEvent` stands in for a real row change on a
   * data-triggered automation, mirroring `ThreadChat.tsx`'s own
   * simulate-event picker for cron/trigger threads. */
  runAutomationNow(automationId: string, simulateEvent?: TriggerEvent): Promise<void>;

  /** Every run this automation has ever fired, most recent first — what
   * `AutomationRunsView` lists ("the ACP chats initiated by the
   * trigger"). */
  listAutomationRuns(automationId: string): Promise<AutomationRunSummary[]>;

  /** One run's full transcript — see `AutomationRun.updates`. */
  getAutomationRun(automationId: string, runId: string): Promise<AutomationRun>;

  /** Fired by the Rust side whenever a run finishes (or fails) — see
   * `src-tauri/src/automation.rs`'s `emit_run_event`. Payload is just the
   * ids needed to know what to re-fetch, same "no delta payload, just
   * refetch" convention `adapters/db`'s `onDatabasesChanged` already
   * uses. */
  onAutomationRun(handler: (event: { automationId: string; runId: string }) => void): () => void;
}
