// Bridges the Agent chat drawer (ux/agent/AgentPanel.tsx) to the
// Rust-side ACP client (src-tauri/src/acp.rs, the dendroid_acp crate) —
// spawns the agent binary configured in Settings and speaks the Agent
// Client Protocol to it over stdio. Throws/no-ops outside Tauri (see
// `unavailable.ts`): there's nothing able to spawn a subprocess in the
// web/wasm preview build, so this feature simply isn't available there.
//
// Every method takes a `threadId` (a lib/types.ts `ChatThread.id`) — a
// window can hold several chat threads open against the agent at once
// (see AgentPanel.tsx and src-tauri/src/state.rs's `acp_key`), each with
// its own independent agent process and ACP session, so nothing here is
// "the" session anymore the way it was before multi-thread support.

import type { AgentSettings } from "../../lib/types";

export class AgentUnavailableError extends Error {
  constructor() {
    super("Agent chat is only available in the desktop app");
    this.name = "AgentUnavailableError";
  }
}

/** A `session/update` notification's raw `params` — see the ACP spec for
 * `sessionUpdate` kinds (`"agent_message_chunk"`, `"agent_thought_chunk"`,
 * `"tool_call"`, `"tool_call_update"`, `"plan"`, …). Left loosely typed
 * rather than modeled field-by-field, mirroring `dendroid_acp::AcpEvent::
 * Update`'s own doc comment: `AgentPanel.tsx` picks out what it renders and
 * ignores the rest, so a future ACP update kind doesn't need a Rust *and*
 * TypeScript schema change to reach the UI. */
export type AcpUpdate = { sessionUpdate?: string; [key: string]: unknown };

/** Mirrors `src-tauri/src/acp.rs`'s `AcpEventEnvelope` — `threadId` plus
 * whatever `AcpEventPayload`'s `#[serde(tag = "kind", rename_all =
 * "camelCase")]` enum serializes to, flattened onto the same object. */
export type AcpBridgeEvent =
  | { kind: "update"; threadId: string; payload: AcpUpdate }
  | {
      kind: "permissionRequest";
      threadId: string;
      requestId: unknown;
      params: { toolCall?: Record<string, unknown>; options?: AcpPermissionOption[]; [key: string]: unknown };
    }
  | { kind: "closed"; threadId: string; error?: string | null };

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind?: string;
}

export interface AcpAdapter {
  /** Spawns `agent.command` (with `agent.args`, working directory `cwd`),
   * completes the ACP handshake, and opens a session for `threadId` —
   * everything that thread needs before it can send a prompt. Throws
   * `AgentUnavailableError` outside Tauri, or whatever error the Rust side
   * reports (bad command, agent crashed during handshake, …).
   *
   * `mcpUrl` is Settings' "Local MCP" URL (`http://host:port/mcp`) when
   * that server is enabled, `null` otherwise — pass `null` there instead
   * of anything computed from a stale/disabled config. The Rust side only
   * actually offers it to the agent if the agent's own handshake said it
   * supports the `"http"` MCP transport; see `src-tauri/src/acp.rs`'s
   * `acp_start`. Whichever skills Settings' "Skills" section has enabled
   * are then just whatever the agent sees when it lists that server's
   * tools — nothing here re-applies that filtering. */
  startAgent(threadId: string, cwd: string, agent: AgentSettings, mcpUrl: string | null): Promise<void>;

  /** Kills `threadId`'s agent process, if any. Safe to call when nothing
   * is connected. */
  stopAgent(threadId: string): Promise<void>;

  /** Sends one user turn as plain text on `threadId`'s session and
   * resolves once the agent's turn fully ends — the turn's actual content
   * streams separately, as `"update"` events via `onAgentEvent`, for as
   * long as this call is pending. */
  sendPrompt(threadId: string, text: string): Promise<{ stopReason?: string }>;

  /** Asks `threadId`'s agent to stop its current turn early — the
   * in-flight `sendPrompt()` call is expected to resolve shortly after,
   * typically with `stopReason: "cancelled"`. */
  cancelPrompt(threadId: string): Promise<void>;

  /** Answers a pending permission request from a `"permissionRequest"`
   * event on `threadId` — `requestId` must be that event's own
   * `requestId`, `outcome` the ACP `RequestPermissionOutcome` (e.g.
   * `{outcome: "selected", optionId: "..."}` or `{outcome:
   * "cancelled"}`). */
  respondPermission(threadId: string, requestId: unknown, outcome: Record<string, unknown>): Promise<void>;

  /** Subscribes to this window's agent session events, across every
   * thread it has open — forwarded 1:1 from the Rust side's `acp://event`
   * (see `src-tauri/src/acp.rs`), each carrying its own `threadId` for the
   * handler to route by. Returns an unsubscribe function — same contract
   * every other event-subscribing adapter method in this app follows. */
  onAgentEvent(handler: (event: AcpBridgeEvent) => void): () => void;
}
