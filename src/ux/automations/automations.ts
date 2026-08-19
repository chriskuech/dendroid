// CRUD for the persisted automation list (lib/types.ts's `Automation`),
// backed by the same Tauri store settingsStore.ts uses for `ChatThread`/
// `Skill` — mirrors ux/agent/threads.ts's/ux/skills/skills.ts's shape. Every mutation
// re-syncs the automation engine afterward (`syncAutomationsEngine`), same
// reasoning as ux/skills/skills.ts's own mutate helper.

import { adapter as settingsStore } from "../../adapters/settingsStore";
import type { Automation, AutomationDataTrigger, CronSchedule } from "../../lib/types";
import { adapter as automationsEngine } from "../../adapters/automationsEngine";

export async function listAutomations(): Promise<Automation[]> {
  return settingsStore.loadAutomations();
}

async function mutate(fn: (automations: Automation[]) => Automation[]): Promise<Automation[]> {
  const next = fn(await settingsStore.loadAutomations());
  await settingsStore.saveAutomations(next);
  void automationsEngine.syncAutomationsEngine();
  return next;
}

export interface NewAutomationInput {
  name: string;
  skillId: string;
  cron?: CronSchedule;
  data?: AutomationDataTrigger;
}

export async function createAutomation(input: NewAutomationInput): Promise<Automation> {
  const automation: Automation = {
    id: crypto.randomUUID(),
    name: input.name.trim() || "New automation",
    skillId: input.skillId,
    cron: input.cron,
    data: input.data,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  await mutate((automations) => [...automations, automation]);
  return automation;
}

export async function updateAutomation(id: string, patch: NewAutomationInput): Promise<void> {
  await mutate((automations) =>
    automations.map((a) => (a.id === id ? { ...a, name: patch.name.trim() || a.name, skillId: patch.skillId, cron: patch.cron, data: patch.data } : a)),
  );
}

export async function setAutomationEnabled(id: string, enabled: boolean): Promise<void> {
  await mutate((automations) => automations.map((a) => (a.id === id ? { ...a, enabled } : a)));
}

export async function deleteAutomation(id: string): Promise<void> {
  await mutate((automations) => automations.filter((a) => a.id !== id));
}

/** Compiles a form-driven `CronSchedule` down to the 5-field cron
 * expression the engine's matcher (`src-tauri/src/automation.rs`'s
 * `cron_matches`) understands — only ever `*` or a single integer per
 * field, since that's all the friendly frequency/time-of-day form can
 * produce. A hand-typed raw expression would use richer syntax (lists,
 * steps) that matcher also accepts, but nothing in this UI generates that
 * today. */
export function cronScheduleToExpression(schedule: CronSchedule): string {
  const { frequency, minute, hour, weekday } = schedule;
  if (frequency === "hourly") return `${minute} * * * *`;
  if (frequency === "daily") return `${minute} ${hour} * * *`;
  return `${minute} ${hour} * * ${weekday}`;
}

/** The inverse of `cronScheduleToExpression`, for re-opening an existing
 * automation in the edit form — best-effort: an expression this app didn't
 * generate itself (hand-edited storage, an older format) falls back to a
 * sane "daily at 9am" default rather than failing to open the form at
 * all. */
export function cronExpressionToSchedule(expr: string): CronSchedule {
  const fields = expr.trim().split(/\s+/);
  const [minStr, hourStr, , , dowStr] = fields;
  const minute = Number(minStr);
  const hour = Number(hourStr);
  const weekday = Number(dowStr);
  if (fields.length !== 5 || Number.isNaN(minute)) {
    return { frequency: "daily", minute: 0, hour: 9, weekday: 1 };
  }
  if (hourStr === "*") return { frequency: "hourly", minute, hour: 0, weekday: 1 };
  if (!Number.isNaN(hour) && dowStr !== "*" && !Number.isNaN(weekday)) {
    return { frequency: "weekly", minute, hour, weekday };
  }
  return { frequency: "daily", minute, hour: Number.isNaN(hour) ? 9 : hour, weekday: 1 };
}

/** A short, human-readable summary of when a schedule runs — the
 * automation list's subtitle and the form's live preview. */
export function describeCronSchedule(schedule: CronSchedule): string {
  const time = `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  if (schedule.frequency === "hourly") return `Hourly at :${String(schedule.minute).padStart(2, "0")}`;
  if (schedule.frequency === "daily") return `Daily at ${time}`;
  const weekdayName = WEEKDAY_NAMES[schedule.weekday] ?? "?";
  return `Weekly on ${weekdayName} at ${time}`;
}

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
