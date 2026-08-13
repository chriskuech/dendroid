// A chat UI over an Agent Client Protocol (ACP) agent — see lib/acp.ts for
// the Tauri bridge and src-tauri/src/acp.rs / src-acp for what actually
// speaks the protocol to a spawned agent process. Connects lazily (the
// first message sent) rather than the moment the drawer opens, so opening
// it to look isn't itself an action with a side effect.
//
// `timeline` is one flat, ordered list rather than separate arrays for
// messages/tool calls/permission prompts — the agent can interleave a tool
// call between two message chunks, and a single array is the only way the
// render order stays true to that.
//
// If Settings' "Local MCP" server is enabled, its URL goes along on
// connect so the agent can use it as an MCP server — see `handleSend`.
// Which of its tools the agent actually sees is controlled entirely by
// Settings' "Skills" section (`disabledSkills`), enforced server-side in
// `src-mcp`; nothing here re-applies that filtering.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import {
  cancelPrompt,
  respondPermission,
  sendPrompt,
  startAgent,
  type AcpBridgeEvent,
  type AcpPermissionOption,
  type AcpUpdate,
  onAgentEvent,
} from "../../lib/acp";
import type { AgentSettings, McpSettings } from "../../lib/types";
import { AgentIcon, CloseIcon } from "../icons";
import "../../styles/agent.css";

type TimelineItem =
  | { id: string; kind: "message"; role: "user" | "agent"; text: string; streaming?: boolean }
  | { id: string; kind: "thought"; text: string; streaming?: boolean }
  | { id: string; kind: "toolCall"; toolCallId: string; title: string; status: string }
  | { id: string; kind: "permission"; requestId: unknown; title: string; options: AcpPermissionOption[]; resolvedOptionId?: string }
  | { id: string; kind: "system"; text: string };

type Connection = "idle" | "connecting" | "connected" | "error";

function newId(): string {
  return crypto.randomUUID();
}

/** Best-effort text out of an ACP `ContentBlock` (or an array of them) —
 * `{type: "text", text: "..."}` is what dendroid's chat UI knows how to
 * render; anything else (image/audio/resource blocks) is silently skipped
 * rather than rendered as a JSON dump. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(extractText).join("");
  if (content && typeof content === "object") {
    const block = content as Record<string, unknown>;
    if (typeof block.text === "string") return block.text;
  }
  return "";
}

function appendMessageChunk(prev: TimelineItem[], chunk: string): TimelineItem[] {
  if (!chunk) return prev;
  const last = prev[prev.length - 1];
  if (last && last.kind === "message" && last.role === "agent" && last.streaming) {
    return [...prev.slice(0, -1), { ...last, text: last.text + chunk }];
  }
  return [...prev, { id: newId(), kind: "message", role: "agent", text: chunk, streaming: true }];
}

function appendThoughtChunk(prev: TimelineItem[], chunk: string): TimelineItem[] {
  if (!chunk) return prev;
  const last = prev[prev.length - 1];
  if (last && last.kind === "thought" && last.streaming) {
    return [...prev.slice(0, -1), { ...last, text: last.text + chunk }];
  }
  return [...prev, { id: newId(), kind: "thought", text: chunk, streaming: true }];
}

function applyUpdate(prev: TimelineItem[], update: AcpUpdate): TimelineItem[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return appendMessageChunk(prev, extractText(update.content));
    case "agent_thought_chunk":
      return appendThoughtChunk(prev, extractText(update.content));
    case "tool_call":
    case "tool_call_update": {
      const toolCallId = String(update.toolCallId ?? update.id ?? "tool");
      const title = typeof update.title === "string" ? update.title : "Tool call";
      const status = typeof update.status === "string" ? update.status : "pending";
      const idx = prev.findIndex((item) => item.kind === "toolCall" && item.toolCallId === toolCallId);
      if (idx === -1) return [...prev, { id: newId(), kind: "toolCall", toolCallId, title, status }];
      const next = [...prev];
      next[idx] = { ...(next[idx] as Extract<TimelineItem, { kind: "toolCall" }>), title, status };
      return next;
    }
    default:
      // "plan" and any future update kind: nothing dendroid's chat UI
      // renders yet, but not an error either — just skip it.
      return prev;
  }
}

function finalizeStreaming(prev: TimelineItem[]): TimelineItem[] {
  return prev.map((item) => (("streaming" in item) && item.streaming ? { ...item, streaming: false } : item));
}

interface AgentPanelProps {
  cwd: string;
  agentSettings: AgentSettings;
  /** Settings' "Local MCP" config — when enabled, its URL is offered to
   * the agent as an MCP server on connect (see `handleSend`'s `startAgent`
   * call), so whatever's left enabled under Settings' "Skills" section
   * becomes something this session can call. */
  mcpSettings: McpSettings;
  open: boolean;
  onClose: () => void;
}

export function AgentPanel({ cwd, agentSettings, mcpSettings, open, onClose }: AgentPanelProps) {
  const [connection, setConnection] = useState<Connection>("idle");
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  const connectionRef = useRef<Connection>("idle");
  connectionRef.current = connection;

  useEffect(() => {
    return onAgentEvent((event: AcpBridgeEvent) => {
      if (event.kind === "update") {
        setTimeline((prev) => applyUpdate(prev, event.payload));
      } else if (event.kind === "permissionRequest") {
        const title = (event.params.toolCall?.title as string | undefined) ?? "Agent requests permission";
        setTimeline((prev) => [
          ...prev,
          { id: newId(), kind: "permission", requestId: event.requestId, title, options: event.params.options ?? [] },
        ]);
      } else if (event.kind === "closed") {
        setConnection("idle");
        setTimeline((prev) => [
          ...finalizeStreaming(prev),
          { id: newId(), kind: "system", text: event.error ? `Agent disconnected: ${event.error}` : "Agent disconnected" },
        ]);
      }
    });
  }, []);

  // Resets the whole conversation (and drops the connection) whenever the
  // open workspace changes — a stale transcript talking about a different
  // set of notes would just be confusing left in place.
  useEffect(() => {
    setConnection("idle");
    setTimeline([]);
  }, [cwd]);

  useEffect(() => {
    if (!open) return;
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, timeline]);

  const configured = agentSettings.command.trim().length > 0;

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || busy || !configured) return;
    setInput("");
    setTimeline((prev) => [...prev, { id: newId(), kind: "message", role: "user", text }]);
    setBusy(true);
    try {
      if (connectionRef.current !== "connected") {
        setConnection("connecting");
        const mcpUrl = mcpSettings.enabled ? `http://${mcpSettings.host}:${mcpSettings.port}/mcp` : null;
        await startAgent(cwd, agentSettings, mcpUrl);
        setConnection("connected");
      }
      const result = await sendPrompt(text);
      setTimeline((prev) => finalizeStreaming(prev));
      if (result?.stopReason && result.stopReason !== "end_turn") {
        setTimeline((prev) => [...prev, { id: newId(), kind: "system", text: `Turn ended: ${result.stopReason}` }]);
      }
    } catch (err) {
      setConnection("error");
      setTimeline((prev) => [
        ...finalizeStreaming(prev),
        { id: newId(), kind: "system", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
      ]);
    } finally {
      setBusy(false);
    }
  }, [input, busy, configured, cwd, agentSettings, mcpSettings]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  const handlePermissionChoice = useCallback(async (item: Extract<TimelineItem, { kind: "permission" }>, option: AcpPermissionOption) => {
    setTimeline((prev) =>
      prev.map((i) => (i.id === item.id && i.kind === "permission" ? { ...i, resolvedOptionId: option.optionId } : i)),
    );
    await respondPermission(item.requestId, { outcome: "selected", optionId: option.optionId });
  }, []);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const style: CSSProperties = {
    transform: open ? "translateX(0)" : "translateX(100%)",
    transition: "transform 200ms cubic-bezier(0.2, 0, 0, 1)",
    pointerEvents: open ? "auto" : "none",
  };

  const statusLabel =
    connection === "connecting" ? "Connecting…" : connection === "connected" ? "Connected" : connection === "error" ? "Error" : "";

  return (
    <>
      {open && <div className="agent-panel__backdrop" onClick={onClose} />}
      <div className="agent-panel" style={style} aria-hidden={!open}>
        <div className="agent-panel__header">
          <AgentIcon size={14} />
          <span className="agent-panel__title">Agent</span>
          {statusLabel && <span className={`agent-panel__status${connection === "error" ? " agent-panel__status--error" : ""}`}>{statusLabel}</span>}
          <button type="button" className="agent-panel__close" onClick={onClose} aria-label="Close agent chat">
            <CloseIcon size={16} />
          </button>
        </div>

        {!configured ? (
          <div className="agent-panel__configure">
            <span>No agent command configured yet.</span>
            <span>Set one under Settings → Agent to start chatting.</span>
          </div>
        ) : (
          <>
            <div className="agent-panel__timeline" ref={timelineRef}>
              {timeline.length === 0 && <div className="agent-panel__empty">Send a message to connect and start a session.</div>}
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
                            onClick={() => void handlePermissionChoice(item, option)}
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
                <button type="button" className="btn btn--secondary" onClick={() => void cancelPrompt()}>
                  Cancel
                </button>
              ) : (
                <button type="button" className="btn btn--primary" onClick={() => void handleSend()} disabled={!input.trim()}>
                  Send
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
