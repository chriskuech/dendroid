import { adapter as settingsStore } from "../settingsStore";
import type { Automation, AutomationRun, AutomationRunSummary, TriggerEvent } from "../../lib/types";
import { DEFAULT_SETTINGS } from "../../lib/types";
import type { AutomationsEngineAdapter } from "./types";

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

// Kept local rather than importing ux/automations/automations.ts's
// `cronScheduleToExpression` to avoid a require cycle (that module imports
// this adapter for its own post-mutate sync call); trivial enough to
// duplicate the one-line compile step.
function cronToExpression(automation: Automation): string {
  const cron = automation.cron;
  if (!cron) return "";
  if (cron.frequency === "hourly") return `${cron.minute} * * * *`;
  if (cron.frequency === "daily") return `${cron.minute} ${cron.hour} * * *`;
  return `${cron.minute} ${cron.hour} * * ${cron.weekday}`;
}

export function createTauriAutomationsEngine(): AutomationsEngineAdapter {
  // The engine needs a working directory to spawn the configured agent in,
  // but automations themselves aren't workspace-scoped (see this module's
  // doc comment) — so it's tracked here as its own bit of state, set by
  // whichever `Workspace` is currently open, rather than threaded through
  // every automation/skill CRUD call.
  let currentCwd: string | null = null;

  async function syncAutomationsEngine(): Promise<void> {
    if (!currentCwd) return;
    try {
      const [automations, skills, appSettings] = await Promise.all([
        settingsStore.loadAutomations(),
        settingsStore.loadSkills(),
        settingsStore.loadAppSettings(),
      ]);
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

  return {
    setAutomationsCwd(cwd) {
      currentCwd = cwd;
      void syncAutomationsEngine();
    },

    syncAutomationsEngine,

    async runAutomationNow(automationId, simulateEvent) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("automation_run_now", { automationId, simulateEvent: simulateEvent ?? null });
    },

    async listAutomationRuns(automationId) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<AutomationRunSummary[]>("automation_runs_list", { automationId });
    },

    async getAutomationRun(automationId, runId) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<AutomationRun>("automation_run_get", { automationId, runId });
    },

    onAutomationRun(handler) {
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
    },
  };
}
