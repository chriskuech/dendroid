// The sidebar's Skills tab — list/create/edit/delete, mirroring
// DatabaseListView.tsx's shape (header + scrollable content) but with a
// small internal screen stack instead of a flat list, since editing a
// skill needs its own form screen rather than a modal (see SkillForm.tsx).
//
// Split out of AutomationsView.tsx, which used to hold Skills as a
// Segmented sub-tab alongside Triggers — a skill is reusable across
// triggers rather than owned by any one of them, so it earns its own rail
// icon instead of living inside the Automations tab.

import { useCallback, useEffect, useState } from "react";
import { createSkill, deleteSkill, listSkills, updateSkill } from "./skills";
import type { Skill } from "../../lib/types";
import { BackIcon, SkillIcon } from "../../ui/icons";
import { SidePanelHeader } from "../../ui/SidePanelHeader";
import { SkillForm } from "./SkillForm";
import { SkillList } from "./SkillList";
import "./skills.css";

type Screen = { kind: "list" } | { kind: "form"; skill: Skill | null };

export function SkillsView() {
  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    return listSkills()
      .then((s) => {
        setSkills(s);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="side-panel skill-view">
      <SidePanelHeader
        icon={
          screen.kind === "list" ? (
            <SkillIcon size={16} />
          ) : (
            <button type="button" className="side-panel__icon-btn" onClick={() => setScreen({ kind: "list" })} aria-label="Back">
              <BackIcon size={16} />
            </button>
          )
        }
        label={screen.kind === "list" ? "Skills" : screen.skill ? "Edit skill" : "New skill"}
      />

      <div className="skill-view__body">
        {loading ? (
          <div className="skill-view__status">Loading…</div>
        ) : error ? (
          <div className="skill-view__status skill-view__status--error">{error}</div>
        ) : screen.kind === "list" ? (
          <SkillList
            skills={skills}
            onNew={() => setScreen({ kind: "form", skill: null })}
            onEdit={(skill) => setScreen({ kind: "form", skill })}
            onDelete={(id) => void deleteSkill(id).then(refresh)}
          />
        ) : (
          <SkillForm
            skill={screen.skill}
            onSave={async (input) => {
              if (screen.skill) await updateSkill(screen.skill.id, input);
              else await createSkill(input);
              await refresh();
              setScreen({ kind: "list" });
            }}
            onCancel={() => setScreen({ kind: "list" })}
          />
        )}
      </div>
    </div>
  );
}
