// The chat drawer — see adapters/acp for the Tauri bridge and
// src-tauri/src/acp.rs / src-acp for what actually speaks the protocol to a
// spawned agent process. Manages three kinds of chat threads (lib/types.ts's
// `ChatThread`): "human" (a person types, the agent replies — the whole of
// what this drawer used to be), "cron" (runs on a schedule) and "trigger"
// (fires on a database row insert/update/delete). See `ChatThread`'s doc
// comment for the current scope: dendroid doesn't run a background
// scheduler or hook into SQLite's own triggers yet, so cron/trigger threads
// are created and configured here but only ever actually run via their
// chat view's manual "Run now" (ThreadChat.tsx).
//
// This component owns every thread's live state — its saved `ChatThread`
// list (ux/agent/threads.ts), its streamed timeline, its connection status —
// and is the sole `onAgentEvent` subscriber for the window, routing each
// incoming event to the right thread by its `threadId` (see adapters/acp).
// That's what lets a cron/trigger thread keep streaming in the background
// while a different thread is the one actually shown. ThreadList.tsx,
// NewThreadForm.tsx and ThreadChat.tsx are pure presentation over this
// state; each screen swaps in for the others rather than living side by
// side, since the drawer is a fixed ~320px column with no room to spare.
//
// Connects lazily (the first message sent, or "Run now") rather than the
// moment a thread's chat view opens, so opening it to look isn't itself an
// action with a side effect.
//
// If Settings' "Local MCP" server is enabled, its URL goes along on
// connect so the agent can use it as an MCP server. Which of its tools the
// agent actually sees is controlled entirely by Settings' "Skills" section
// (`disabledSkills`), enforced server-side in `src-mcp`; nothing here
// re-applies that filtering.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAcp } from "../../adapters/acp/context";
import type { AcpBridgeEvent, AcpPermissionOption } from "../../adapters/acp";
import { createThread, deleteThread as deleteThreadRecord, listThreads, type NewThreadInput } from "./threads";
import type { AgentSettings, ChatThread, McpSettings } from "../../lib/types";
import { AgentIcon } from "../../ui/icons";
import { OverlayPanel } from "../../ui/OverlayPanel";
import { SidePanelHeader } from "../../ui/SidePanelHeader";
import { NewThreadForm } from "./NewThreadForm";
import { ThreadChat } from "./ThreadChat";
import { ThreadList } from "./ThreadList";
import { applyUpdate, finalizeStreaming, newTimelineId, type TimelineItem } from "./timelineUpdates";
import "./agent.css";

type Connection = "idle" | "connecting" | "connected" | "error";

interface AgentPanelProps {
  cwd: string;
  agentSettings: AgentSettings;
  /** Settings' "Local MCP" config — when enabled, its URL is offered to
   * the agent as an MCP server on connect, so whatever's left enabled
   * under Settings' "Skills" section becomes something a thread's session
   * can call. */
  mcpSettings: McpSettings;
  open: boolean;
  onClose: () => void;
}

function withEntry<T>(map: Record<string, T>, id: string, value: T): Record<string, T> {
  return { ...map, [id]: value };
}

export function AgentPanel({ cwd, agentSettings, mcpSettings, open, onClose }: AgentPanelProps) {
  const acp = useAcp();
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [timelines, setTimelines] = useState<Record<string, TimelineItem[]>>({});
  const [connections, setConnections] = useState<Record<string, Connection>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  // Mirrors `connections` synchronously — `handleSend` needs to know
  // whether *this* thread is already connected without racing its own
  // `setConnections` call, same reason the old single-thread version of
  // this component kept a `connectionRef`.
  const connectionsRef = useRef<Record<string, Connection>>({});
  connectionsRef.current = connections;

  useEffect(() => {
    listThreads().then(setThreads);
  }, []);

  useEffect(() => {
    return acp.onAgentEvent((event: AcpBridgeEvent) => {
      const id = event.threadId;
      if (event.kind === "update") {
        setTimelines((prev) => withEntry(prev, id, applyUpdate(prev[id] ?? [], event.payload)));
      } else if (event.kind === "permissionRequest") {
        const title = (event.params.toolCall?.title as string | undefined) ?? "Agent requests permission";
        const item: TimelineItem = {
          id: newTimelineId(),
          kind: "permission",
          requestId: event.requestId,
          title,
          options: event.params.options ?? [],
        };
        setTimelines((prev) => withEntry(prev, id, [...(prev[id] ?? []), item]));
      } else if (event.kind === "closed") {
        setConnections((prev) => withEntry(prev, id, "idle"));
        const note: TimelineItem = {
          id: newTimelineId(),
          kind: "system",
          text: event.error ? `Agent disconnected: ${event.error}` : "Agent disconnected",
        };
        setTimelines((prev) => withEntry(prev, id, [...finalizeStreaming(prev[id] ?? []), note]));
      }
    });
  }, [acp]);

  // Resets every thread's live connection state whenever the open
  // workspace changes — a stale transcript talking about a different set
  // of notes would just be confusing left in place. The saved thread list
  // itself isn't workspace-scoped (see ux/agent/threads.ts's doc comment), so
  // it's untouched here.
  useEffect(() => {
    setActiveThreadId(null);
    setCreating(false);
    setTimelines({});
    setConnections({});
    setBusy({});
  }, [cwd]);

  const configured = agentSettings.command.trim().length > 0;

  const handleCreateThread = useCallback(async (input: NewThreadInput) => {
    const thread = await createThread(input);
    setThreads((prev) => [...prev, thread]);
    setCreating(false);
    setActiveThreadId(thread.id);
  }, []);

  const handleDeleteThread = useCallback(
    async (id: string) => {
      setThreads((prev) => prev.filter((t) => t.id !== id));
      setTimelines((prev) => {
        const { [id]: _removed, ...rest } = prev;
        return rest;
      });
      setConnections((prev) => {
        const { [id]: _removed, ...rest } = prev;
        return rest;
      });
      if (activeThreadId === id) setActiveThreadId(null);
      await acp.stopAgent(id);
      await deleteThreadRecord(id);
    },
    [activeThreadId, acp],
  );

  const handleSend = useCallback(
    async (threadId: string, text: string) => {
      const userMessage: TimelineItem = { id: newTimelineId(), kind: "message", role: "user", text };
      setTimelines((prev) => withEntry(prev, threadId, [...(prev[threadId] ?? []), userMessage]));
      setBusy((prev) => withEntry(prev, threadId, true));
      try {
        if (connectionsRef.current[threadId] !== "connected") {
          setConnections((prev) => withEntry(prev, threadId, "connecting"));
          const mcpUrl = mcpSettings.enabled ? `http://${mcpSettings.host}:${mcpSettings.port}/mcp` : null;
          await acp.startAgent(threadId, cwd, agentSettings, mcpUrl);
          setConnections((prev) => withEntry(prev, threadId, "connected"));
        }
        const result = await acp.sendPrompt(threadId, text);
        setTimelines((prev) => withEntry(prev, threadId, finalizeStreaming(prev[threadId] ?? [])));
        if (result?.stopReason && result.stopReason !== "end_turn") {
          const note: TimelineItem = { id: newTimelineId(), kind: "system", text: `Turn ended: ${result.stopReason}` };
          setTimelines((prev) => withEntry(prev, threadId, [...(prev[threadId] ?? []), note]));
        }
      } catch (err) {
        setConnections((prev) => withEntry(prev, threadId, "error"));
        const note: TimelineItem = { id: newTimelineId(), kind: "system", text: `Error: ${err instanceof Error ? err.message : String(err)}` };
        setTimelines((prev) => withEntry(prev, threadId, [...finalizeStreaming(prev[threadId] ?? []), note]));
      } finally {
        setBusy((prev) => withEntry(prev, threadId, false));
      }
    },
    [cwd, agentSettings, mcpSettings, acp],
  );

  const handlePermissionChoice = useCallback(
    async (threadId: string, item: Extract<TimelineItem, { kind: "permission" }>, option: AcpPermissionOption) => {
      setTimelines((prev) =>
        withEntry(
          prev,
          threadId,
          (prev[threadId] ?? []).map((i) => (i.id === item.id && i.kind === "permission" ? { ...i, resolvedOptionId: option.optionId } : i)),
        ),
      );
      await acp.respondPermission(threadId, item.requestId, { outcome: "selected", optionId: option.optionId });
    },
    [acp],
  );

  const activeThread = activeThreadId ? (threads.find((t) => t.id === activeThreadId) ?? null) : null;

  return (
    <OverlayPanel
      side="right"
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="Agent chat"
      widthPx={320}
      onBackdropClick={onClose}
      // Escape steps back one screen at a time — out of the new-thread
      // form, or out of a thread's chat back to the list — and only closes
      // the whole drawer once there's nowhere left to go back to. Radix's
      // default (close on Escape) is overridden with this custom
      // multi-step behavior instead.
      onEscapeKeyDown={(e) => {
        e.preventDefault();
        if (creating) setCreating(false);
        else if (activeThreadId) setActiveThreadId(null);
        else onClose();
      }}
    >
      {creating ? (
        <NewThreadForm onCreate={(input) => void handleCreateThread(input)} onCancel={() => setCreating(false)} />
      ) : activeThread ? (
        <ThreadChat
          key={activeThread.id}
          thread={activeThread}
          timeline={timelines[activeThread.id] ?? []}
          connection={connections[activeThread.id] ?? "idle"}
          busy={!!busy[activeThread.id]}
          configured={configured}
          onBack={() => setActiveThreadId(null)}
          onClose={onClose}
          onSend={(text) => void handleSend(activeThread.id, text)}
          onCancel={() => void acp.cancelPrompt(activeThread.id)}
          onPermissionChoice={(item, option) => void handlePermissionChoice(activeThread.id, item, option)}
        />
      ) : (
        <>
          <SidePanelHeader icon={<AgentIcon size={14} />} label="Threads" onClose={onClose} closeLabel="Close agent chat" />
          <ThreadList threads={threads} onSelect={setActiveThreadId} onNew={() => setCreating(true)} onDelete={(id) => void handleDeleteThread(id)} />
        </>
      )}
    </OverlayPanel>
  );
}
