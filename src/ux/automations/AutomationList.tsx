// The Automations tab's row list — mirrors ux/skills/SkillList.tsx's shape,
// but a row's click drills into that automation's runs ("the ACP chats
// initiated by the trigger") rather than opening it for editing straight
// away, since that's the more common thing to want out of an existing
// trigger — editing gets its own pencil button instead (see PencilIcon).

import { useState } from "react";
import { describeCronSchedule } from "./automations";
import type { Automation, Skill } from "../../lib/types";
import { AutomationIcon, IncrementIcon, PencilIcon, TrashIcon } from "../../ui/icons";
import { ConfirmDialog } from "../../ui/ConfirmDialog";

interface AutomationListProps {
  automations: Automation[];
  skills: Skill[];
  onNew: () => void;
  onEdit: (automation: Automation) => void;
  onOpenRuns: (automation: Automation) => void;
  onDelete: (id: string) => void;
  onToggleEnabled: (automation: Automation, enabled: boolean) => void;
}

function subtitle(automation: Automation, skills: Skill[]): string {
  const skillName = skills.find((s) => s.id === automation.skillId)?.name ?? "no skill";
  const parts: string[] = [];
  if (automation.cron) parts.push(describeCronSchedule(automation.cron));
  if (automation.data) parts.push(`${automation.data.table} ${automation.data.events.join("/")}`);
  return `${parts.join(" · ") || "Not configured"} → ${skillName}`;
}

export function AutomationList({ automations, skills, onNew, onEdit, onOpenRuns, onDelete, onToggleEnabled }: AutomationListProps) {
  const [pendingDelete, setPendingDelete] = useState<Automation | null>(null);

  return (
    <div className="automation-list">
      <div className="automation-list__rows">
        {automations.length === 0 ? (
          <div className="automation-view__status">
            No triggers yet.
            <br />
            A trigger runs a skill on a schedule, on a database change, or both.
          </div>
        ) : (
          automations.map((automation) => (
            <div key={automation.id} className={`automation-row${automation.enabled ? "" : " automation-row--disabled"}`} onClick={() => onOpenRuns(automation)}>
              <AutomationIcon size={13} />
              <div className="automation-row__body">
                <span className="automation-row__title">{automation.name}</span>
                <span className="automation-row__sub">{subtitle(automation, skills)}</span>
              </div>
              <input
                type="checkbox"
                className="automation-row__enabled"
                checked={automation.enabled}
                title={automation.enabled ? "Disable" : "Enable"}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => onToggleEnabled(automation, event.target.checked)}
              />
              <span
                className="automation-row__edit"
                title="Edit trigger"
                onClick={(event) => {
                  event.stopPropagation();
                  onEdit(automation);
                }}
              >
                <PencilIcon size={12} />
              </span>
              <span
                className="automation-row__delete"
                title="Delete trigger"
                onClick={(event) => {
                  event.stopPropagation();
                  setPendingDelete(automation);
                }}
              >
                <TrashIcon size={12} />
              </span>
            </div>
          ))
        )}
      </div>
      <div className="automation-list__new">
        <button type="button" className="btn btn--primary automation-list__new-btn" onClick={onNew}>
          <IncrementIcon size={12} />
          New trigger
        </button>
      </div>
      <ConfirmDialog
        open={pendingDelete !== null}
        icon={TrashIcon}
        title="Delete trigger"
        body={pendingDelete ? `Permanently delete "${pendingDelete.name}"? Its past runs stay on disk but it will stop firing.` : ""}
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
