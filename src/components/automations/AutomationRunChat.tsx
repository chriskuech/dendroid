// One run's transcript, read-only — the actual "ACP chat" a trigger fire
// initiated. `run.updates` is every raw `session/update` payload the agent
// streamed while this run was live (see lib/types.ts's `AutomationRun`);
// folding it through the same `applyUpdate`/`finalizeStreaming` a *live*
// thread's chat uses (components/agent/timelineUpdates.ts) reconstructs the exact
// same `TimelineItem[]` shape, so `Timeline.tsx` renders it identically —
// just once, from a finished array, instead of incrementally off events.

import { useEffect, useState } from "react";
import { getAutomationRun } from "../../lib/automationsEngine";
import type { AutomationRun } from "../../lib/types";
import { applyUpdate, finalizeStreaming, type TimelineItem } from "../agent/timelineUpdates";
import { Timeline } from "../agent/Timeline";

interface AutomationRunChatProps {
  automationId: string;
  runId: string;
}

function buildTimeline(run: AutomationRun): TimelineItem[] {
  let timeline: TimelineItem[] = [{ id: "prompt", kind: "message", role: "user", text: run.prompt }];
  for (const update of run.updates) {
    // `run.updates` entries mirror lib/acp.ts's `AcpUpdate` — untyped raw
    // JSON on the wire, same reasoning as that type's own doc comment.
    timeline = applyUpdate(timeline, update as { sessionUpdate?: string; [key: string]: unknown });
  }
  timeline = finalizeStreaming(timeline);
  if (run.status === "error" && run.error) {
    timeline = [...timeline, { id: "run-error", kind: "system", text: `Error: ${run.error}` }];
  } else if (run.stopReason && run.stopReason !== "end_turn") {
    timeline = [...timeline, { id: "run-stop", kind: "system", text: `Turn ended: ${run.stopReason}` }];
  }
  return timeline;
}

export function AutomationRunChat({ automationId, runId }: AutomationRunChatProps) {
  const [run, setRun] = useState<AutomationRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRun(null);
    setError(null);
    getAutomationRun(automationId, runId)
      .then((r) => {
        if (!cancelled) setRun(r);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [automationId, runId]);

  if (error) {
    return <div className="automation-view__status automation-view__status--error">{error}</div>;
  }
  if (!run) {
    return <div className="automation-view__status">Loading…</div>;
  }

  return (
    <div className="automation-run-chat">
      <div className="agent-panel__timeline">
        <Timeline timeline={buildTimeline(run)} />
      </div>
    </div>
  );
}
