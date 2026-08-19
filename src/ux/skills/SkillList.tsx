// The Skills tab's row list — mirrors ThreadList.tsx's shape (rows + a "+
// New" footer button + a delete confirmation), but a row's own click opens
// it for *editing* rather than a chat: a skill has no ACP session of its
// own, unlike a thread or an automation's runs.

import { useState } from "react";
import type { Skill } from "../../lib/types";
import { IncrementIcon, SkillIcon, TrashIcon } from "../../ui/icons";
import { ConfirmDialog } from "../../ui/ConfirmDialog";

interface SkillListProps {
  skills: Skill[];
  onNew: () => void;
  onEdit: (skill: Skill) => void;
  onDelete: (id: string) => void;
}

export function SkillList({ skills, onNew, onEdit, onDelete }: SkillListProps) {
  const [pendingDelete, setPendingDelete] = useState<Skill | null>(null);

  return (
    <div className="skill-list">
      <div className="skill-list__rows">
        {skills.length === 0 ? (
          <div className="skill-view__status">
            No skills yet.
            <br />
            A skill is a reusable prompt a trigger runs each time it fires.
          </div>
        ) : (
          skills.map((skill) => (
            <div key={skill.id} className="skill-row" onClick={() => onEdit(skill)}>
              <SkillIcon size={13} />
              <div className="skill-row__body">
                <span className="skill-row__title">{skill.name}</span>
                <span className="skill-row__sub">{skill.description || "No description"}</span>
              </div>
              <span
                className="skill-row__delete"
                title="Delete skill"
                onClick={(event) => {
                  event.stopPropagation();
                  setPendingDelete(skill);
                }}
              >
                <TrashIcon size={12} />
              </span>
            </div>
          ))
        )}
      </div>
      <div className="skill-list__new">
        <button type="button" className="btn btn--primary skill-list__new-btn" onClick={onNew}>
          <IncrementIcon size={12} />
          New skill
        </button>
      </div>
      <ConfirmDialog
        open={pendingDelete !== null}
        icon={TrashIcon}
        title="Delete skill"
        body={pendingDelete ? `Permanently delete "${pendingDelete.name}"? Any triggers using it will stop firing.` : ""}
        confirmLabel="Delete"
        onConfirm={() => {
          if (pendingDelete) onDelete(pendingDelete.id);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
