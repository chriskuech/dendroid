// Bridges the Agent chat drawer (components/agent/AgentPanel.tsx) to the
// Rust-side ACP client (src-tauri/src/acp.rs, the dendroid_acp crate) —
// spawns the agent binary configured in Settings and speaks the Agent
// Client Protocol to it over stdio. A no-op (or throwing) outside Tauri,
// same as lib/mcp.ts: there's nothing able to spawn a subprocess in the
// web/wasm preview build, so this feature simply isn't available there.
//
// Every export here takes a `threadId` (a lib/types.ts `ChatThread.id`) —
// a window can hold several chat threads open against the agent at once
// (see AgentPanel.tsx and src-tauri/src/state.rs's `acp_key`), each with
// its own independent agent process and ACP session, so nothing here is
// "the" session anymore the way it was before multi-thread support.

import type { AgentSettings } from "./types";

function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

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

function splitArgs(args: string): string[] {
  return args.split(/\s+/).filter(Boolean);
}

/** Spawns `agent.command` (with `agent.args`, working directory `cwd`),
 * completes the ACP handshake, and opens a session for `threadId` —
 * everything that thread needs before it can send a prompt. Throws
 * `AgentUnavailableError` outside Tauri, or whatever error the Rust side
 * reports (bad command, agent crashed during handshake, …).
 *
 * `mcpUrl` is Settings' "Local MCP" URL (`http://host:port/mcp`) when that
 * server is enabled, `null` otherwise — pass `null` there instead of
 * anything computed from a stale/disabled config. The Rust side only
 * actually offers it to the agent if the agent's own handshake said it
 * supports the `"http"` MCP transport; see `src-tauri/src/acp.rs`'s
 * `acp_start`. Whichever skills Settings' "Skills" section has enabled are
 * then just whatever the agent sees when it lists that server's tools —
 * nothing here re-applies that filtering. */
export async function startAgent(threadId: string, cwd: string, agent: AgentSettings, mcpUrl: string | null): Promise<void> {
  if (!hasTauri()) throw new AgentUnavailableError();
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("acp_start", { threadId, command: agent.command, args: splitArgs(agent.args), cwd, mcpUrl });
}

/** Kills `threadId`'s agent process, if any. Safe to call when nothing is
 * connected. No-op outside Tauri. */
export async function stopAgent(threadId: string): Promise<void> {
  if (!hasTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("acp_stop", { threadId });
}

/** Sends one user turn as plain text on `threadId`'s session and resolves
 * once the agent's turn fully ends — the turn's actual content streams
 * separately, as `"update"` events via `onAgentEvent`, for as long as this
 * call is pending. */
export async function sendPrompt(threadId: string, text: string): Promise<{ stopReason?: string }> {
  if (!hasTauri()) throw new AgentUnavailableError();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("acp_send_prompt", { threadId, text });
}

/** Asks `threadId`'s agent to stop its current turn early — the in-flight
 * `sendPrompt()` call is expected to resolve shortly after, typically with
 * `stopReason: "cancelled"`. */
export async function cancelPrompt(threadId: string): Promise<void> {
  if (!hasTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("acp_cancel", { threadId });
}

/** Answers a pending permission request from a `"permissionRequest"` event
 * on `threadId` — `requestId` must be that event's own `requestId`,
 * `outcome` the ACP `RequestPermissionOutcome` (e.g. `{outcome: "selected",
 * optionId: "..."}` or `{outcome: "cancelled"}`). */
export async function respondPermission(threadId: string, requestId: unknown, outcome: Record<string, unknown>): Promise<void> {
  if (!hasTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("acp_respond_permission", { threadId, requestId, outcome });
}

/** Subscribes to this window's agent session events, across every thread it
 * has open — forwarded 1:1 from the Rust side's `acp://event` (see
 * `src-tauri/src/acp.rs`), each carrying its own `threadId` for the handler
 * to route by. No-op outside Tauri. Returns an unsubscribe function — same
 * contract every other `listen`-wrapping helper in this app follows (see
 * App.tsx's menu listeners). */
export function onAgentEvent(handler: (event: AcpBridgeEvent) => void): () => void {
  if (!hasTauri()) return () => {};
  let unlisten: (() => void) | undefined;
  let cancelled = false;
  void import("@tauri-apps/api/event").then(({ listen }) => {
    if (cancelled) return;
    void listen<AcpBridgeEvent>("acp://event", (e) => handler(e.payload)).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
