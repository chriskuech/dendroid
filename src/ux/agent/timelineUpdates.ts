// Pure helpers for turning a stream of ACP `session/update` notifications
// (adapters/acp's `AcpUpdate`) into the flat, ordered `TimelineItem[]`
// ThreadChat.tsx renders. Split out of AgentPanel.tsx so that component can
// stay focused on *which* thread's timeline is being updated (it now
// tracks one per open thread — see its own doc comment) rather than also
// carrying this update-folding logic.
//
// One flat list rather than separate arrays for messages/tool calls/
// permission prompts — the agent can interleave a tool call between two
// message chunks, and a single array is the only way the render order
// stays true to that.

import type { AcpPermissionOption, AcpUpdate } from "../../adapters/acp";

export type TimelineItem =
  | { id: string; kind: "message"; role: "user" | "agent"; text: string; streaming?: boolean }
  | { id: string; kind: "thought"; text: string; streaming?: boolean }
  | { id: string; kind: "toolCall"; toolCallId: string; title: string; status: string }
  | { id: string; kind: "permission"; requestId: unknown; title: string; options: AcpPermissionOption[]; resolvedOptionId?: string }
  | { id: string; kind: "system"; text: string };

function newId(): string {
  return crypto.randomUUID();
}

/** Best-effort text out of an ACP `ContentBlock` (or an array of them) —
 * `{type: "text", text: "..."}` is what dendroid's chat UI knows how to
 * render; anything else (image/audio/resource blocks) is silently skipped
 * rather than rendered as a JSON dump. */
export function extractText(content: unknown): string {
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

export function applyUpdate(prev: TimelineItem[], payload: AcpUpdate): TimelineItem[] {
  // `payload` is a `session/update` notification's raw `params` — per the
  // ACP spec (and `src-acp/tests/roundtrip.rs`'s fixture) that's
  // `{sessionId, update: {sessionUpdate, ...}}`, not the inner update
  // object itself. Unwrap it here, once, rather than at every call site
  // (`AgentPanel.tsx`'s live event handler and `AutomationRunChat.tsx`'s
  // replay both hand this straight through from the wire) — falling back
  // to `payload` itself keeps this working for callers/tests that already
  // pass the unwrapped shape.
  const update = (payload.update as AcpUpdate | undefined) ?? payload;
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

export function finalizeStreaming(prev: TimelineItem[]): TimelineItem[] {
  return prev.map((item) => ("streaming" in item && item.streaming ? { ...item, streaming: false } : item));
}

export function newTimelineId(): string {
  return newId();
}
