// CRUD for the persisted skill list (lib/types.ts's `Skill`), backed by the
// same Tauri store settingsStore.ts uses for `ChatThread`/`Automation` —
// mirrors lib/threads.ts's shape closely on purpose. Every mutation re-syncs
// the automation engine afterward (`syncAutomationsEngine`): an automation
// only ever stores a `skillId`, so an edit to a skill's `instructions` here
// has to reach the Rust-side engine's own copy (it keeps a resolved
// snapshot, not a live reference — see `lib/automationsEngine.ts`) or the
// next fire would run stale instructions.

import { loadSkills, saveSkills } from "./settingsStore";
import type { Skill } from "./types";
import { syncAutomationsEngine } from "./automationsEngine";

export async function listSkills(): Promise<Skill[]> {
  return loadSkills();
}

async function mutate(fn: (skills: Skill[]) => Skill[]): Promise<Skill[]> {
  const next = fn(await loadSkills());
  await saveSkills(next);
  void syncAutomationsEngine();
  return next;
}

export interface NewSkillInput {
  name: string;
  description: string;
  instructions: string;
}

export async function createSkill(input: NewSkillInput): Promise<Skill> {
  const skill: Skill = {
    id: crypto.randomUUID(),
    name: input.name.trim() || "New skill",
    description: input.description.trim(),
    instructions: input.instructions,
    createdAt: new Date().toISOString(),
  };
  await mutate((skills) => [...skills, skill]);
  return skill;
}

export async function updateSkill(id: string, patch: NewSkillInput): Promise<void> {
  await mutate((skills) =>
    skills.map((s) =>
      s.id === id ? { ...s, name: patch.name.trim() || s.name, description: patch.description.trim(), instructions: patch.instructions } : s,
    ),
  );
}

export async function deleteSkill(id: string): Promise<void> {
  await mutate((skills) => skills.filter((s) => s.id !== id));
}
