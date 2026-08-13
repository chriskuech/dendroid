// Covers the chat UI's own logic — connecting on first send, streaming
// `session/update` chunks into the timeline, and answering a permission
// request — against a mocked `lib/acp.ts`, same "vi.mock stands in for the
// Tauri IPC boundary" approach `DatabaseListView.test.tsx` uses for `lib/db.ts`.

import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentPanel } from "./AgentPanel";
import * as acp from "../../lib/acp";
import type { AcpBridgeEvent } from "../../lib/acp";
import type { AgentSettings, McpSettings } from "../../lib/types";

vi.mock("../../lib/acp", async () => {
  const actual = await vi.importActual<typeof import("../../lib/acp")>("../../lib/acp");
  return {
    ...actual,
    startAgent: vi.fn(),
    stopAgent: vi.fn(),
    sendPrompt: vi.fn(),
    cancelPrompt: vi.fn(),
    respondPermission: vi.fn(),
    onAgentEvent: vi.fn(() => () => {}),
  };
});

const agentSettings: AgentSettings = { command: "fake-agent", args: "" };
const mcpSettings: McpSettings = { enabled: false, host: "127.0.0.1", port: 7717, disabledSkills: [] };

/** Grabs whatever handler the component just registered via `onAgentEvent`
 * — there's always exactly one live subscription per mounted `AgentPanel`. */
function lastEventHandler(): (event: AcpBridgeEvent) => void {
  const calls = vi.mocked(acp.onAgentEvent).mock.calls;
  return calls[calls.length - 1][0];
}

describe("AgentPanel", () => {
  it("shows a configure prompt instead of the composer when no command is set", () => {
    render(<AgentPanel cwd="/tmp/ws" agentSettings={{ command: "", args: "" }} mcpSettings={mcpSettings} open onClose={vi.fn()} />);
    expect(screen.getByText(/no agent command configured/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/message the agent/i)).not.toBeInTheDocument();
  });

  it("connects and sends a prompt on first message, showing the user's bubble immediately", async () => {
    vi.mocked(acp.startAgent).mockResolvedValue(undefined);
    vi.mocked(acp.sendPrompt).mockResolvedValue({ stopReason: "end_turn" });
    const user = userEvent.setup();

    render(<AgentPanel cwd="/tmp/ws" agentSettings={agentSettings} mcpSettings={mcpSettings} open onClose={vi.fn()} />);
    await user.type(screen.getByPlaceholderText(/message the agent/i), "hello there{enter}");

    expect(screen.getByText("hello there")).toBeInTheDocument();
    await waitFor(() => expect(acp.startAgent).toHaveBeenCalledWith("/tmp/ws", agentSettings, null));
    expect(acp.sendPrompt).toHaveBeenCalledWith("hello there");
  });

  it("passes the Local MCP URL to startAgent when it's enabled", async () => {
    vi.mocked(acp.startAgent).mockResolvedValue(undefined);
    vi.mocked(acp.sendPrompt).mockResolvedValue({ stopReason: "end_turn" });
    const user = userEvent.setup();
    const mcpEnabled: McpSettings = { enabled: true, host: "127.0.0.1", port: 7717, disabledSkills: [] };

    render(<AgentPanel cwd="/tmp/ws" agentSettings={agentSettings} mcpSettings={mcpEnabled} open onClose={vi.fn()} />);
    await user.type(screen.getByPlaceholderText(/message the agent/i), "hello{enter}");

    await waitFor(() =>
      expect(acp.startAgent).toHaveBeenCalledWith("/tmp/ws", agentSettings, "http://127.0.0.1:7717/mcp"),
    );
  });

  it("streams agent_message_chunk updates into a single growing bubble", async () => {
    render(<AgentPanel cwd="/tmp/ws" agentSettings={agentSettings} mcpSettings={mcpSettings} open onClose={vi.fn()} />);
    const handler = lastEventHandler();

    handler({ kind: "update", payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } } });
    handler({ kind: "update", payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo!" } } });

    expect(await screen.findByText("Hello!")).toBeInTheDocument();
  });

  it("renders a tool_call update with its title and status", async () => {
    render(<AgentPanel cwd="/tmp/ws" agentSettings={agentSettings} mcpSettings={mcpSettings} open onClose={vi.fn()} />);
    const handler = lastEventHandler();

    handler({ kind: "update", payload: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Reading outline.md", status: "in_progress" } });

    const call = await screen.findByText("Reading outline.md");
    expect(call.closest(".agent-tool-call")?.querySelector(".agent-tool-call__dot--in_progress")).toBeInTheDocument();
  });

  it("shows a permission request and answers it, disabling the option once chosen", async () => {
    vi.mocked(acp.respondPermission).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<AgentPanel cwd="/tmp/ws" agentSettings={agentSettings} mcpSettings={mcpSettings} open onClose={vi.fn()} />);
    const handler = lastEventHandler();

    handler({
      kind: "permissionRequest",
      requestId: "req-1",
      params: { toolCall: { title: "Run rm -rf ledger/" }, options: [{ optionId: "allow", name: "Allow" }, { optionId: "reject", name: "Reject" }] },
    });

    expect(await screen.findByText("Run rm -rf ledger/")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Allow" }));

    expect(acp.respondPermission).toHaveBeenCalledWith("req-1", { outcome: "selected", optionId: "allow" });
    expect(await screen.findByRole("button", { name: /allow ✓/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });

  it("shows a system note and resets the connection when the agent closes", async () => {
    render(<AgentPanel cwd="/tmp/ws" agentSettings={agentSettings} mcpSettings={mcpSettings} open onClose={vi.fn()} />);
    const handler = lastEventHandler();

    handler({ kind: "closed", error: "process exited" });

    expect(await screen.findByText(/agent disconnected: process exited/i)).toBeInTheDocument();
  });

  it("calls onClose from the close button", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<AgentPanel cwd="/tmp/ws" agentSettings={agentSettings} mcpSettings={mcpSettings} open onClose={onClose} />);
    await user.click(screen.getByLabelText(/close agent chat/i));
    expect(onClose).toHaveBeenCalled();
  });
});
