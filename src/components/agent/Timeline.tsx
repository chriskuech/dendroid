// The `TimelineItem[]` -> markup mapping — split out of ThreadChat.tsx so
// AutomationRunChat.tsx (a *read-only* transcript viewer for a finished
// automation run) can render exactly the same message/thought/tool-call/
// permission bubbles a live thread's chat does, without duplicating the
// markup or dragging in ThreadChat's composer/run-bar/live-connection
// concerns. `onPermissionChoice` is optional for that reason: a past run's
// permission prompts are already resolved (or never will be — the run is
// over), so AutomationRunChat renders them as inert history rather than
// live buttons.

import type { AcpPermissionOption } from "../../lib/acp";
import type { TimelineItem } from "./timelineUpdates";

interface TimelineProps {
  timeline: TimelineItem[];
  onPermissionChoice?: (item: Extract<TimelineItem, { kind: "permission" }>, option: AcpPermissionOption) => void;
}

export function Timeline({ timeline, onPermissionChoice }: TimelineProps) {
  return (
    <>
      {timeline.map((item) => {
        if (item.kind === "message") {
          return (
            <div key={item.id} className={`agent-message agent-message--${item.role}${item.streaming ? " is-streaming" : ""}`}>
              {item.text}
            </div>
          );
        }
        if (item.kind === "thought") {
          return (
            <div key={item.id} className={`agent-message agent-message--thought${item.streaming ? " is-streaming" : ""}`}>
              {item.text}
            </div>
          );
        }
        if (item.kind === "toolCall") {
          return (
            <div key={item.id} className="agent-tool-call">
              <span className={`agent-tool-call__dot agent-tool-call__dot--${item.status}`} />
              <span>{item.title}</span>
            </div>
          );
        }
        if (item.kind === "permission") {
          return (
            <div key={item.id} className="agent-permission">
              <span>{item.title}</span>
              <div className="agent-permission__actions">
                {item.options.map((option) => (
                  <button
                    key={option.optionId}
                    type="button"
                    className="btn btn--secondary"
                    disabled={!onPermissionChoice || !!item.resolvedOptionId}
                    onClick={() => onPermissionChoice?.(item, option)}
                  >
                    {item.resolvedOptionId === option.optionId ? `${option.name} ✓` : option.name}
                  </button>
                ))}
              </div>
            </div>
          );
        }
        return (
          <div key={item.id} className="agent-message agent-message--system">
            {item.text}
          </div>
        );
      })}
    </>
  );
}
