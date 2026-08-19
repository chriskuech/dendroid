// Covers the chat UI's own logic: creating a "human" thread, connecting and
// sending on first message, streaming `session/update` chunks into that
// thread's timeline, and answering a permission request — against a mocked
// `adapters/acp`, same "vi.mock stands in for the Tauri IPC boundary"
// approach `DatabaseListView.test.tsx` uses for `adapters/db`.
//
// `ux/agent/threads.ts` itself isn't mocked (its id-generation/default-title
// logic is worth exercising for real) but the `adapters/settingsStore` calls
// underneath it are, backed by a plain array reset in `beforeEach` — the
// store's own `settingsStore.ts` module keeps a lazy singleton `MemoryStore`
// outside Tauri that would otherwise leak saved threads from one test into
// the next.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentPanel } from "./AgentPanel";
import * as acp from "../../adapters/acp";
import type { AcpBridgeEvent } from "../../adapters/acp";
import * as settingsStore from "../../adapters/settingsStore";
import type { AgentSettings, ChatThread, McpSettings } from "../../lib/types";

vi.mock("../../adapters/acp", async () => {
  const actual = await vi.importActual<typeof import("../../adapters/acp")>("../../adapters/acp");
  return {
    ...actual,
    adapter: {
      ...actual.adapter,
      startAgent: vi.fn(),
      stopAgent: vi.fn(),
      sendPrompt: vi.fn(),
      cancelPrompt: vi.fn(),
      respondPermission: vi.fn(),
      onAgentEvent: vi.fn(() => () => {}),
    },
  };
});

vi.mock("../../adapters/settingsStore", async () => {
  const actual = await vi.importActual<typeof import("../../adapters/settingsStore")>("../../adapters/settingsStore");
  return { ...actual, adapter: { ...actual.adapter, loadThreads: vi.fn(), saveThreads: vi.fn() } };
});

const agentSettings: AgentSettings = { provider: "custom", command: "fake-agent", args: "" };
const mcpSettings: McpSettings = { enabled: false, host: "127.0.0.1", port: 7717, disabledSkills: [] };

beforeEach(() => {
  let saved: ChatThread[] = [];
  vi.mocked(settingsStore.adapter.loadThreads).mockImplementation(async () => saved);
  vi.mocked(settingsStore.adapter.saveThreads).mockImplementation(async (threads) => {
    saved = threads;
  });
});

/** Grabs whatever handler the component just registered via `onAgentEvent`
 * — there's always exactly one live subscription per mounted `AgentPanel`. */
function lastEventHandler(): (event: AcpBridgeEvent) => void {
  const calls = vi.mocked(acp.adapter.onAgentEvent).mock.calls;
  return calls[calls.length - 1][0];
}

/** The id `AgentPanel` generated for whichever thread's chat is currently
 * on screen — see `ThreadChat.tsx`'s `data-thread-id`. Needed because
 * simulated `onAgentEvent` calls route by `threadId`, and that id is
 * otherwise only ever visible to `adapters/acp` calls a given test may not
 * have triggered yet (e.g. before the first message is sent). */
function activeThreadId(): string {
  const el = document.querySelector("[data-thread-id]");
  if (!el) throw new Error("no thread chat is currently open");
  return el.getAttribute("data-thread-id")!;
}

/** Creates and opens a "human" thread — the entry point every test below
 * needs before it can reach the composer, since the drawer now always
 * lands on the thread list first (see AgentPanel.tsx's doc comment). */
async function openNewHumanThread(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /new thread/i }));
  await user.click(screen.getByRole("button", { name: /^create$/i }));
  await screen.findByPlaceholderText(/message the agent/i);
}

describe("AgentPanel", () => {
  it("lands on an empty thread list with no threads yet", async () => {
    render(<AgentPanel cwd="/tmp/ws" agentSettings={agentSettings} mcpSettings={mcpSettings} open onClose={vi.fn()} width={320} onResize={vi.fn()} />);
    expect(await screen.findByText(/no chat threads yet/i)).toBeInTheDocument();
  });

  it("shows a configure prompt instead of the composer when no command is set", async () => {
    const user = userEvent.setup();
    render(
      <AgentPanel cwd="/tmp/ws" agentSettings={{ provider: "none", command: "", args: "" }} mcpSettings={mcpSettings} open onClose={vi.fn()} width={320} onResize={vi.fn()} />,
    );
    await user.click(await screen.findByRole("button", { name: /new thread/i }));
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    expect(await screen.findByText(/no agent command configured/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/message the agent/i)).not.toBeInTheDocument();
  });

  it("connects and sends a prompt on first message, showing the user's bubble immediately", async () => {
    vi.mocked(acp.adapter.startAgent).mockResolvedValue(undefined);
    vi.mocked(acp.adapter.sendPrompt).mockResolvedValue({ stopReason: "end_turn" });
    const user = userEvent.setup();

    render(<AgentPanel cwd="/tmp/ws" agentSettings={agentSettings} mcpSettings={mcpSettings} open onClose={vi.fn()} width={320} onResize={vi.fn()} />);
    await openNewHumanThread(user);
    await user.type(screen.getByPlaceholderText(/message the agent/i), "hello there{enter}");

    expect(screen.getByText("hello there")).toBeInTheDocument();
    await waitFor(() => expect(acp.adapter.startAgent).toHaveBeenCalledWith(expect.any(String), "/tmp/ws", agentSettings, null));
    expect(acp.adapter.sendPrompt).toHaveBeenCalledWith(expect.any(String), "hello there");
  });

  it("passes the Local MCP URL to startAgent when it's enabled", async () => {
    vi.mocked(acp.adapter.startAgent).mockResolvedValue(undefined);
    vi.mocked(acp.adapter.sendPrompt).mockResolvedValue({ stopReason: "end_turn" });
    const user = userEvent.setup();
    const mcpEnabled: McpSettings = { enabled: true, host: "127.0.0.1", port: 7717, disabledSkills: [] };

    render(<AgentPanel cwd="/tmp/ws" agentSettings={agentSettings} mcpSettings={mcpEnabled} open onClose={vi.fn()} width={320} onResize={vi.fn()} />);
    await openNewHumanThread(user);
    await user.type(screen.getByPlaceholderText(/message the agent/i), "hello{enter}");

    await waitFor(() =>
      expect(acp.adapter.startAgent).toHaveBeenCalledWith(expect.any(String), "/tmp/ws", agentSettings, "http://127.0.0.1:7717/mcp"),
    );
  });

  it("streams agent_message_chunk updates into a single growing bubble", async () => {
    const user = userEvent.setup();
    render(<AgentPanel cwd="/tmp/ws" agentSettings={agentSettings} mcpSettings={mcpSettings} open onClose={vi.fn()} width={320} onResize={vi.fn()} />);
    await openNewHumanThread(user);
    const handler = lastEventHandler();

    // The handler routes events by their own `threadId` field, independent
    // of whichever id `startAgent` ends up called with — since only one
    // thread is open here, any id lands in the timeline currently on screen.
    handler({ kind: "update", threadId: activeThreadId(), payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } } });
    handler({ kind: "update", threadId: activeThreadId(), payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo!" } } });

    expect(await screen.findByText("Hello!")).toBeInTheDocument();
  });

  it("renders a tool_call update with its title and status", async () => {
    const user = userEvent.setup();
    render(<AgentPanel cwd="/tmp/ws" agentSettings={agentSettings} mcpSettings={mcpSettings} open onClose={vi.fn()} width={320} onResize={vi.fn()} />);
    await openNewHumanThread(user);
    const handler = lastEventHandler();

    handler({
      kind: "update",
      threadId: activeThreadId(),
      payload: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Reading outline.md", status: "in_progress" },
    });

    const call = await screen.findByText("Reading outline.md");
    expect(call.closest(".agent-tool-call")?.querySelector(".agent-tool-call__dot--in_progress")).toBeInTheDocument();
  });

  it("shows a permission request and answers it, disabling the option once chosen", async () => {
    vi.mocked(acp.adapter.respondPermission).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<AgentPanel cwd="/tmp/ws" agentSettings={agentSettings} mcpSettings={mcpSettings} open onClose={vi.fn()} width={320} onResize={vi.fn()} />);
    await openNewHumanThread(user);
    const handler = lastEventHandler();

    handler({
      kind: "permissionRequest",
      threadId: activeThreadId(),
      requestId: "req-1",
      params: { toolCall: { title: "Run rm -rf ledger/" }, options: [{ optionId: "allow", name: "Allow" }, { optionId: "reject", name: "Reject" }] },
    });

    expect(await screen.findByText("Run rm -rf ledger/")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Allow" }));

    expect(acp.adapter.respondPermission).toHaveBeenCalledWith(expect.any(String), "req-1", { outcome: "selected", optionId: "allow" });
    expect(await screen.findByRole("button", { name: /allow ✓/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });

  it("shows a system note and resets the connection when the agent closes", async () => {
    const user = userEvent.setup();
    render(<AgentPanel cwd="/tmp/ws" agentSettings={agentSettings} mcpSettings={mcpSettings} open onClose={vi.fn()} width={320} onResize={vi.fn()} />);
    await openNewHumanThread(user);
    const handler = lastEventHandler();

    handler({ kind: "closed", threadId: activeThreadId(), error: "process exited" });

    expect(await screen.findByText(/agent disconnected: process exited/i)).toBeInTheDocument();
  });

  it("returns to the thread list on back, then closes the drawer on close", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<AgentPanel cwd="/tmp/ws" agentSettings={agentSettings} mcpSettings={mcpSettings} open onClose={onClose} width={320} onResize={vi.fn()} />);
    await openNewHumanThread(user);

    await user.click(screen.getByLabelText(/back to threads/i));
    expect(await screen.findByRole("button", { name: /new thread/i })).toBeInTheDocument();

    await user.click(screen.getByLabelText(/close agent chat/i));
    expect(onClose).toHaveBeenCalled();
  });

  it("creates a cron thread with its schedule shown, and deletes it", async () => {
    const user = userEvent.setup();
    render(<AgentPanel cwd="/tmp/ws" agentSettings={agentSettings} mcpSettings={mcpSettings} open onClose={vi.fn()} width={320} onResize={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: /new thread/i }));
    await user.click(screen.getByRole("radio", { name: /scheduled/i }));
    await user.type(screen.getByPlaceholderText(/what should the agent do each time/i), "Summarize today's notes");
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    expect(await screen.findByText("0 9 * * *")).toBeInTheDocument();
    expect(screen.getByText(/no live scheduler yet/i)).toBeInTheDocument();

    await user.click(screen.getByLabelText(/back to threads/i));
    expect(await screen.findByText(/scheduled ·/i)).toBeInTheDocument();

    await user.click(screen.getByTitle(/delete thread/i));
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(await screen.findByText(/no chat threads yet/i)).toBeInTheDocument();
  });
});
