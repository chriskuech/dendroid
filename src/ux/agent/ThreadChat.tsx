// One thread's conversation — the timeline + composer that used to be all
// of AgentPanel.tsx before it grew thread management. Purely presentational
// plus its own composer draft state; AgentPanel.tsx owns the timeline
// array, connection status, and every handler passed in here, the same
// "container owns state, this owns markup" split ThreadList.tsx follows.
// Always mounted with `key={thread.id}` by AgentPanel.tsx, so switching
// threads gets a clean composer rather than carrying over a draft meant
// for a different conversation.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AcpPermissionOption } from "../../adapters/acp";
import type { ChatThread } from "../../lib/types";
import { AgentIcon, BackIcon } from "../../ui/icons";
import { SidePanelHeader } from "../../ui/SidePanelHeader";
import { Timeline } from "./Timeline";
import type { TimelineItem } from "./timelineUpdates";

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

  const statusLabel =
    connection === "connecting" ? "Connecting…" : connection === "connected" ? "Connected" : connection === "error" ? "Error" : "";

  return (
    // `data-thread-id` isn't read by any dendroid code — it's a hook for
    // AgentPanel.test.tsx to find whichever id `AgentPanel` generated for
    // the thread currently on screen, since that's otherwise only visible
    // to `adapters/acp` calls the test may not have triggered yet.
    <div className="thread-chat" data-thread-id={thread.id}>
      <SidePanelHeader
        icon={
          <>
            <button type="button" className="side-panel__icon-btn" onClick={onBack} aria-label="Back to threads">
              <BackIcon size={16} />
            </button>
            <AgentIcon size={13} />
          </>
        }
        label={thread.title}
        status={statusLabel}
        statusError={connection === "error"}
        onClose={onClose}
        closeLabel="Close agent chat"
      />

      {!configured ? (
        <div className="agent-panel__configure">
          <span>No agent command configured yet.</span>
          <span>Set one under Settings → Agent to start chatting.</span>
        </div>
      ) : (
        <>
          <div className="agent-panel__timeline" ref={timelineRef}>
            {timeline.length === 0 && <div className="agent-panel__empty">Send a message to connect and start a session.</div>}
            <Timeline timeline={timeline} onPermissionChoice={onPermissionChoice} />
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
