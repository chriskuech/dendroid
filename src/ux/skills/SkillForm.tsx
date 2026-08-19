// Add/edit a Skill (lib/types.ts) — name, a short description (shown as
// the row subtitle in SkillList.tsx), and the instructions actually sent
// to the agent as its prompt whenever a trigger referencing this skill
// fires. Mirrors NewThreadForm.tsx's body/footer shape.

import { useState } from "react";
import type { NewSkillInput } from "./skills";
import type { Skill } from "../../lib/types";
import { Button } from "../../ui/Button";

interface SkillFormProps {
  skill: Skill | null;
  onSave: (input: NewSkillInput) => void | Promise<void>;
  onCancel: () => void;
}

export function SkillForm({ skill, onSave, onCancel }: SkillFormProps) {
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [instructions, setInstructions] = useState(skill?.instructions ?? "");
  const [saving, setSaving] = useState(false);

  const canSave = name.trim().length > 0 && instructions.trim().length > 0;

  async function handleSave() {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      await onSave({ name, description, instructions });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="skill-form">
      <div className="skill-form__body">
        <div className="field">
          <span className="field__label">Name</span>
          <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="New skill" autoFocus />
        </div>
        <div className="field">
          <span className="field__label">Description</span>
          <input
            className="field-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this skill is for, at a glance"
          />
        </div>
        <div className="field">
          <span className="field__label">Instructions</span>
          <textarea
            className="field-input thread-form__skill"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="What should the agent do each time a trigger runs this skill?"
            rows={8}
          />
          <span className="field__hint">Sent to the agent as its prompt. A data trigger appends the row-change event as JSON after this.</span>
        </div>
      </div>
      <div className="thread-form__footer">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void handleSave()} disabled={!canSave || saving}>
          {saving ? "Saving…" : skill ? "Save" : "Create"}
        </Button>
      </div>
    </div>
  );
}
