// One automation's fire history — "the ACP chats initiated by the
// trigger". Each row is a separate `AutomationRunSummary` (its own spawned
// agent session, not a shared conversation — see `Automation`'s doc
// comment in lib/types.ts); selecting one opens its transcript in
// AutomationRunChat.tsx. Live off `automations://run` the same way
// DatabaseListView stays live off `db://update`.

import { useCallback, useEffect, useState } from "react";
import { useAutomationsEngine } from "../../adapters/automationsEngine/context";
import type { Automation, AutomationRunSummary, TriggerEvent } from "../../lib/types";
import { AutomationIcon, PlayIcon } from "../../ui/icons";

interface AutomationRunsViewProps {
  automation: Automation;
  onOpenRun: (runId: string) => void;
}

const REASON_LABEL: Record<AutomationRunSummary["reason"], string> = {
  cron: "Scheduled",
  data: "Data change",
  manual: "Run now",
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function AutomationRunsView({ automation, onOpenRun }: AutomationRunsViewProps) {
  const automationsEngine = useAutomationsEngine();
  const [runs, setRuns] = useState<AutomationRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [simulateEvent, setSimulateEvent] = useState<TriggerEvent>(automation.data?.events[0] ?? "insert");

  const refresh = useCallback(() => {
    automationsEngine
      .listAutomationRuns(automation.id)
      .then((list) => {
        setRuns(list);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [automation.id, automationsEngine]);

  useEffect(() => {
    refresh();
    return automationsEngine.onAutomationRun((event) => {
      if (event.automationId === automation.id) refresh();
    });
  }, [refresh, automation.id, automationsEngine]);

  const handleRunNow = useCallback(() => {
    if (running) return;
    setRunning(true);
    automationsEngine
      .runAutomationNow(automation.id, automation.data ? simulateEvent : undefined)
      .then(refresh)
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setRunning(false));
  }, [running, automation.id, automation.data, simulateEvent, refresh, automationsEngine]);

  return (
    <div className="automation-runs">
      <div className="automation-runs__toolbar">
        {automation.data && automation.data.events.length > 1 && (
          <select className="field-input thread-chat__run-event" value={simulateEvent} onChange={(e) => setSimulateEvent(e.target.value as TriggerEvent)}>
            {automation.data.events.map((event) => (
              <option key={event} value={event}>
                {event}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="btn btn--secondary thread-chat__run-btn automation-runs__run-btn" onClick={handleRunNow} disabled={running}>
          <PlayIcon size={11} />
          {running ? "Running…" : "Run now"}
        </button>
      </div>
      <div className="automation-list__rows">
        {loading ? (
          <div className="automation-view__status">Loading…</div>
        ) : runs.length === 0 ? (
          <div className="automation-view__status">
            No runs yet.
            <br />
            Use Run now to test this trigger.
          </div>
        ) : (
          runs.map((run) => (
            <div key={run.id} className="automation-row" onClick={() => onOpenRun(run.id)}>
              <AutomationIcon size={13} />
              <div className="automation-row__body">
                <span className="automation-row__title">{formatTime(run.firedAt)}</span>
                <span className="automation-row__sub">
                  {REASON_LABEL[run.reason]}
                  {run.event ? ` · ${run.event.table} ${run.event.event}` : ""}
                </span>
              </div>
              <span className={`automation-runs__status automation-runs__status--${run.status}`}>{run.status}</span>
            </div>
          ))
        )}
        {error && <div className="automation-view__status automation-view__status--error">{error}</div>}
      </div>
    </div>
  );
}
