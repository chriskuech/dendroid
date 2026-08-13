// One thread's conversation — the timeline + composer that used to be all
// of AgentPanel.tsx before it grew thread management. Purely presentational
// plus its own composer/simulate-event input state; AgentPanel.tsx owns the
// timeline array, connection status, and every handler passed in here, the
// same "container owns state, this owns markup" split ThreadList.tsx and
// NewThreadForm.tsx follow. Always mounted with `key={thread.id}` by
// AgentPanel.tsx, so switching threads gets a clean composer rather than
// carrying over a draft meant for a different conversation.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AcpPermissionOption } from "../../lib/acp";
import { buildTriggerEventJson } from "../../lib/threads";
import type { ChatThread, TriggerEvent } from "../../lib/types";
import { BackIcon, CloseIcon, PlayIcon } from "../icons";
import { ThreadKindIcon } from "./ThreadKindIcon";
import type { TimelineItem } from "./timeline";

type Connection = "idle" | "connecting" | "connected" | "error";

interface ThreadChatProps {
  thread: ChatThread;
  timeline: TimelineItem[];
  connection: Connection;
  busy: boolean;
  configured: boolean;
  onBack: () => void;
  onClose: () => void;
  onSend: (text: string) => void;
  onCancel: () => void;
  onPermissionChoice: (item: Extract<TimelineItem, { kind: "permission" }>, option: AcpPermissionOption) => void;
}

export function ThreadChat({ thread, timeline, connection, busy, configured, onBack, onClose, onSend, onCancel, onPermissionChoice }: ThreadChatProps) {
  const [input, setInput] = useState("");
  const [simulateEvent, setSimulateEvent] = useState<TriggerEvent>(thread.trigger?.events[0] ?? "insert");
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [timeline]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || busy || !configured) return;
    setInput("");
    onSend(text);
  }, [input, busy, configured, onSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleRunNow = useCallback(() => {
    if (busy || !configured) return;
    if (thread.kind === "cron" && thread.cron) {
      onSend(thread.cron.skill);
    } else if (thread.kind === "trigger" && thread.trigger) {
      const eventJson = buildTriggerEventJson(thread.trigger, simulateEvent);
      onSend(`${thread.trigger.skill}\n\n${eventJson}`);
    }
  }, [busy, configured, onSend, simulateEvent, thread]);

  const statusLabel =
    connection === "connecting" ? "Connecting…" : connection === "connected" ? "Connected" : connection === "error" ? "Error" : "";

  return (
    // `data-thread-id` isn't read by any dendroid code — it's a hook for
    // AgentPanel.test.tsx to find whichever id `AgentPanel` generated for
    // the thread currently on screen, since that's otherwise only visible
    // to `lib/acp.ts` calls the test may not have triggered yet.
    <div className="thread-chat" data-thread-id={thread.id}>
      <div className="agent-panel__header">
        <button type="button" className="agent-panel__close" onClick={onBack} aria-label="Back to threads">
          <BackIcon size={16} />
        </button>
        <ThreadKindIcon kind={thread.kind} size={13} />
        <span className="agent-panel__title agent-panel__title--thread">{thread.title}</span>
        {statusLabel && <span className={`agent-panel__status${connection === "error" ? " agent-panel__status--error" : ""}`}>{statusLabel}</span>}
        <button type="button" className="agent-panel__close" onClick={onClose} aria-label="Close agent chat">
          <CloseIcon size={16} />
        </button>
      </div>

      {(thread.kind === "cron" && thread.cron) || (thread.kind === "trigger" && thread.trigger) ? (
        <div className="thread-chat__run-bar">
          <div className="thread-chat__run-summary">
            {thread.kind === "cron" && thread.cron ? (
              <span>
                Runs <code>{thread.cron.schedule}</code>
              </span>
            ) : (
              thread.trigger && (
                <span>
                  Fires on <code>{thread.trigger.table}</code> {thread.trigger.events.join("/")}
                </span>
              )
            )}
            <span className="thread-chat__run-hint">No live scheduler yet — use Run now to test.</span>
          </div>
          {thread.kind === "trigger" && thread.trigger && thread.trigger.events.length > 1 && (
            <select className="field-input thread-chat__run-event" value={simulateEvent} onChange={(e) => setSimulateEvent(e.target.value as TriggerEvent)}>
              {thread.trigger.events.map((event) => (
                <option key={event} value={event}>
                  {event}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="btn btn--secondary thread-chat__run-btn" onClick={handleRunNow} disabled={busy || !configured}>
            <PlayIcon size={11} />
            Run now
          </button>
        </div>
      ) : null}

      {!configured ? (
        <div className="agent-panel__configure">
          <span>No agent command configured yet.</span>
          <span>Set one under Settings → Agent to start chatting.</span>
        </div>
      ) : (
        <>
          <div className="agent-panel__timeline" ref={timelineRef}>
            {timeline.length === 0 && (
              <div className="agent-panel__empty">
                {thread.kind === "human" ? "Send a message to connect and start a session." : "Send a message, or use Run now to test this thread."}
              </div>
            )}
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
                          disabled={!!item.resolvedOptionId}
                          onClick={() => onPermissionChoice(item, option)}
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
          </div>

          <div className="agent-panel__composer">
            <textarea
              className="agent-panel__input"
              value={input}
              placeholder="Message the agent…"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={busy}
            />
            {busy ? (
              <button type="button" className="btn btn--secondary" onClick={onCancel}>
                Cancel
              </button>
            ) : (
              <button type="button" className="btn btn--primary" onClick={handleSend} disabled={!input.trim()}>
                Send
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
