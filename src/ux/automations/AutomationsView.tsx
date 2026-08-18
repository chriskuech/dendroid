// The sidebar's Automations tab — mirrors DatabaseListView.tsx's shape
// (header + scrollable content, with a <900px drawer variant) but with its
// own small internal screen stack instead of a flat list, since this tab
// has two sections (Skills/Triggers) plus per-trigger drill-down (its runs,
// then one run's chat) rather than one flat list of selectable rows.
//
//   list (Skills | Triggers, via the Segmented tabs)
//     |-- skillForm      -- add/edit a Skill
//     |-- automationForm -- add/edit a Automation ("trigger")
//     `-- runs           -- one automation's fire history
//           `-- run      -- one run's read-only transcript

import { useCallback, useEffect, useState } from "react";
import { createAutomation, deleteAutomation, listAutomations, setAutomationEnabled, updateAutomation } from "./automations";
import { createSkill, deleteSkill, listSkills, updateSkill } from "./skills";
import type { Automation, Skill } from "../../lib/types";
import { AutomationIcon, BackIcon } from "../../ui/icons";
import { Segmented } from "../../ui/Segmented";
import { SidePanelHeader } from "../../ui/SidePanelHeader";
import { AutomationForm } from "./AutomationForm";
import { AutomationList } from "./AutomationList";
import { AutomationRunChat } from "./AutomationRunChat";
import { AutomationRunsView } from "./AutomationRunsView";
import { SkillForm } from "./SkillForm";
import { SkillList } from "./SkillList";
import "./automations.css";

type Section = "triggers" | "skills";

type Screen =
  | { kind: "list" }
  | { kind: "skillForm"; skill: Skill | null }
  | { kind: "automationForm"; automation: Automation | null }
  | { kind: "runs"; automation: Automation }
  | { kind: "run"; automation: Automation; runId: string };

function screenTitle(screen: Screen): string {
  if (screen.kind === "list") return "Automations";
  if (screen.kind === "skillForm") return screen.skill ? "Edit skill" : "New skill";
  if (screen.kind === "automationForm") return screen.automation ? "Edit trigger" : "New trigger";
  if (screen.kind === "runs") return screen.automation.name;
  return "Run";
}

export function AutomationsView() {
  const [section, setSection] = useState<Section>("triggers");
  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  const [skills, setSkills] = useState<Skill[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    return Promise.all([listSkills(), listAutomations()])
      .then(([s, a]) => {
        setSkills(s);
        setAutomations(a);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function goBack() {
    if (screen.kind === "run") setScreen({ kind: "runs", automation: screen.automation });
    else setScreen({ kind: "list" });
  }

  return (
    <div className="side-panel automation-view">
      <SidePanelHeader
        icon={
          screen.kind === "list" ? (
            <AutomationIcon size={16} />
          ) : (
            <button type="button" className="side-panel__icon-btn" onClick={goBack} aria-label="Back">
              <BackIcon size={16} />
            </button>
          )
        }
        label={screenTitle(screen)}
      />

      {screen.kind === "list" && (
        <div className="automation-view__tabs">
          <Segmented
            value={section}
            onChange={setSection}
            options={[
              { value: "triggers", label: "Triggers" },
              { value: "skills", label: "Skills" },
            ]}
          />
        </div>
      )}

      <div className="automation-view__body">
        {loading ? (
          <div className="automation-view__status">Loading…</div>
        ) : error ? (
          <div className="automation-view__status automation-view__status--error">{error}</div>
        ) : screen.kind === "list" ? (
          section === "skills" ? (
            <SkillList
              skills={skills}
              onNew={() => setScreen({ kind: "skillForm", skill: null })}
              onEdit={(skill) => setScreen({ kind: "skillForm", skill })}
              onDelete={(id) => void deleteSkill(id).then(refresh)}
            />
          ) : (
            <AutomationList
              automations={automations}
              skills={skills}
              onNew={() => setScreen({ kind: "automationForm", automation: null })}
              onEdit={(automation) => setScreen({ kind: "automationForm", automation })}
              onOpenRuns={(automation) => setScreen({ kind: "runs", automation })}
              onDelete={(id) => void deleteAutomation(id).then(refresh)}
              onToggleEnabled={(automation, enabled) => void setAutomationEnabled(automation.id, enabled).then(refresh)}
            />
          )
        ) : screen.kind === "skillForm" ? (
          <SkillForm
            skill={screen.skill}
            onSave={async (input) => {
              if (screen.skill) await updateSkill(screen.skill.id, input);
              else await createSkill(input);
              await refresh();
              setSection("skills");
              setScreen({ kind: "list" });
            }}
            onCancel={() => setScreen({ kind: "list" })}
          />
        ) : screen.kind === "automationForm" ? (
          <AutomationForm
            automation={screen.automation}
            skills={skills}
            onSave={async (input) => {
              if (screen.automation) await updateAutomation(screen.automation.id, input);
              else await createAutomation(input);
              await refresh();
              setSection("triggers");
              setScreen({ kind: "list" });
            }}
            onCancel={() => setScreen({ kind: "list" })}
          />
        ) : screen.kind === "runs" ? (
          <AutomationRunsView automation={screen.automation} onOpenRun={(runId) => setScreen({ kind: "run", automation: screen.automation, runId })} />
        ) : (
          <AutomationRunChat automationId={screen.automation.id} runId={screen.runId} />
        )}
      </div>
    </div>
  );
}
