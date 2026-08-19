// The sidebar's Automations tab — mirrors DatabaseListView.tsx's shape
// (header + scrollable content, with a <900px drawer variant) but with its
// own small internal screen stack instead of a flat list, since this tab
// has per-trigger drill-down (its runs, then one run's chat) rather than
// one flat list of selectable rows.
//
//   list (Triggers)
//     |-- automationForm -- add/edit a Automation ("trigger")
//     `-- runs           -- one automation's fire history
//           `-- run      -- one run's read-only transcript
//
// Skills used to live here too, as a Segmented "Skills" section alongside
// Triggers — they now have their own rail tab (see ux/skills/SkillsView.tsx),
// since a skill is reusable across triggers rather than owned by any one of
// them. This view still loads the skill list, though: a trigger's row
// subtitle names the skill it runs, and AutomationForm's picker needs the
// full list to choose from.

import { useCallback, useEffect, useState } from "react";
import { createAutomation, deleteAutomation, listAutomations, setAutomationEnabled, updateAutomation } from "./automations";
import { listSkills } from "../skills/skills";
import type { Automation, Skill } from "../../lib/types";
import { AutomationIcon, BackIcon } from "../../ui/icons";
import { SidePanelHeader } from "../../ui/SidePanelHeader";
import { AutomationForm } from "./AutomationForm";
import { AutomationList } from "./AutomationList";
import { AutomationRunChat } from "./AutomationRunChat";
import { AutomationRunsView } from "./AutomationRunsView";
import "./automations.css";

type Screen =
  | { kind: "list" }
  | { kind: "automationForm"; automation: Automation | null }
  | { kind: "runs"; automation: Automation }
  | { kind: "run"; automation: Automation; runId: string };

function screenTitle(screen: Screen): string {
  if (screen.kind === "list") return "Automations";
  if (screen.kind === "automationForm") return screen.automation ? "Edit trigger" : "New trigger";
  if (screen.kind === "runs") return screen.automation.name;
  return "Run";
}

export function AutomationsView() {
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

      <div className="automation-view__body">
        {loading ? (
          <div className="automation-view__status">Loading…</div>
        ) : error ? (
          <div className="automation-view__status automation-view__status--error">{error}</div>
        ) : screen.kind === "list" ? (
          <AutomationList
            automations={automations}
            skills={skills}
            onNew={() => setScreen({ kind: "automationForm", automation: null })}
            onEdit={(automation) => setScreen({ kind: "automationForm", automation })}
            onOpenRuns={(automation) => setScreen({ kind: "runs", automation })}
            onDelete={(id) => void deleteAutomation(id).then(refresh)}
            onToggleEnabled={(automation, enabled) => void setAutomationEnabled(automation.id, enabled).then(refresh)}
          />
        ) : screen.kind === "automationForm" ? (
          <AutomationForm
            automation={screen.automation}
            skills={skills}
            onSave={async (input) => {
              if (screen.automation) await updateAutomation(screen.automation.id, input);
              else await createAutomation(input);
              await refresh();
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
