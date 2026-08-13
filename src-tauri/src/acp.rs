//! Bridges the Agent chat drawer (`components/agent/AgentPanel.tsx`) to a
//! spawned ACP-speaking agent subprocess via `dendroid_acp`. One agent
//! session per *chat thread* (`state::AppDocState::acp_sessions`, keyed by
//! `state::acp_key(window_label, thread_id)`) — a window can hold several
//! threads open at once (human-initiated, cron-initiated, trigger-
//! initiated; see `AgentPanel.tsx`'s doc comment), each started on demand
//! rather than automatically: unlike "Local MCP", there's no Settings
//! toggle that starts this on its own — the drawer calls `acp_start` itself
//! the first time a given thread needs a connection (see `lib/acp.ts`'s
//! `startAgent`).
//!
//! Every command here just looks its (window, thread) session up and
//! delegates to `dendroid_acp::AcpClient` — the protocol/process-management
//! logic all lives in that crate, same "thin IPC boundary" shape
//! `commands.rs` uses for the document commands.

use dendroid_acp::{AcpClient, AcpEvent};
use serde::Serialize;
use serde_json::Value as JsonValue;
use tauri::{Emitter, Manager, State, Window};

use crate::state::{acp_key, AcpSession, AppDocState};

/// Emitted to a window for every event any of its threads' agent sessions
/// produce — streamed `session/update` content, a `session/
/// request_permission` ask, or that thread's agent process closing. Always
/// carries `threadId` (see `AcpEventEnvelope`) so `lib/acp.ts`'s
/// `onAgentEvent` can route it to the right thread's timeline even when
/// more than one is connected at once. See `lib/acp.ts`'s `onAgentEvent`.
pub const ACP_EVENT: &str = "acp://event";

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum AcpEventPayload {
    #[serde(rename_all = "camelCase")]
    Update { payload: JsonValue },
    #[serde(rename_all = "camelCase")]
    PermissionRequest { request_id: JsonValue, params: JsonValue },
    #[serde(rename_all = "camelCase")]
    Closed { error: Option<String> },
}

impl From<AcpEvent> for AcpEventPayload {
    fn from(event: AcpEvent) -> Self {
        match event {
            AcpEvent::Update(payload) => AcpEventPayload::Update { payload },
            AcpEvent::PermissionRequest { request_id, params } => AcpEventPayload::PermissionRequest { request_id, params },
            AcpEvent::Closed { error } => AcpEventPayload::Closed { error },
        }
    }
}

/// What actually gets emitted as `ACP_EVENT` — `AcpEventPayload` plus which
/// thread it belongs to. `#[serde(flatten)]` puts `threadId` alongside the
/// payload's own `kind`/fields at the top level, so `lib/acp.ts`'s
/// `AcpBridgeEvent` can stay a plain discriminated union on `kind` with one
/// extra field rather than a nested `{threadId, event: {...}}` shape.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AcpEventEnvelope {
    thread_id: String,
    #[serde(flatten)]
    event: AcpEventPayload,
}

/// Tears down one thread's agent session, if any — used by `acp_stop`,
/// `acp_start` itself (see its doc comment for why starting always
/// restarts), and `stop_all_sessions_for_window` below.
async fn stop_session(state: &AppDocState, key: &str) {
    if let Some(session) = state.acp_sessions.lock().await.remove(key) {
        session.client.shutdown().await;
    }
}

/// Tears down every thread's agent session for `label`'s window — called by
/// `lib.rs`'s `on_window_event` when that window closes, since a closed
/// window can't own any live sessions anymore regardless of how many
/// threads it had open.
pub async fn stop_all_sessions_for_window(state: &AppDocState, label: &str) {
    let prefix = format!("{label}::");
    let keys: Vec<String> = state.acp_sessions.lock().await.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
    for key in keys {
        stop_session(state, &key).await;
    }
}

/// Starts (or restarts) one thread's agent session: spawns `command args`
/// with `cwd` as its working directory, completes the ACP handshake, and
/// opens a session. Always tears down whatever session this (window,
/// thread) pair already had first — same "a config change always restarts
/// rather than trying to diff old vs. new" rule `mcp::apply` follows, since
/// there's no cheap way to tell whether `command`/`args` changed since the
/// last connection. Other threads on the same window are untouched: each
/// gets its own spawned process (see `state::AppDocState::acp_sessions`'s
/// doc comment), so restarting one can't interrupt another's conversation.
///
/// `mcp_url` is Settings' "Local MCP" URL (`http://host:port/mcp`) if that
/// server is currently enabled, `None` otherwise — see `lib/acp.ts`'s
/// `startAgent`. When present *and* the agent's own `initialize` response
/// says it supports the `"http"` MCP transport, it's handed to
/// `session/new` as one of the session's `mcpServers`, so every skill
/// Settings' "Skills" section leaves enabled (`src-mcp`'s `tool_router`,
/// filtered by `mcp::apply`'s `disabled_skills`) becomes something this
/// agent can actually call — nothing dendroid does client-side re-filters
/// or re-lists them, that enforcement already lives in the MCP server
/// itself.
#[tauri::command(rename_all = "camelCase")]
pub async fn acp_start(
    window: Window,
    state: State<'_, AppDocState>,
    thread_id: String,
    command: String,
    args: Vec<String>,
    cwd: String,
    mcp_url: Option<String>,
) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("no agent command configured — set one in Settings".to_string());
    }

    let label = window.label().to_string();
    let key = acp_key(&label, &thread_id);
    stop_session(&state, &key).await;

    let (client, mut events) = AcpClient::spawn(&command, &args, &cwd).await.map_err(|e| e.to_string())?;
    let mcp_servers = match mcp_url {
        Some(url) if client.supports_mcp_http() => {
            vec![serde_json::json!({ "type": "http", "name": "dendroid", "url": url, "headers": [] })]
        }
        // Either "Local MCP" is off, or the agent's `initialize` response
        // never advertised `mcpCapabilities.http` — either way the session
        // opens without it rather than sending an entry the agent said it
        // can't use.
        _ => Vec::new(),
    };
    let session_id = client.new_session(&cwd, mcp_servers).await.map_err(|e| e.to_string())?;

    // Forwards every event for this thread's session to its own window,
    // for as long as the session lives — mirrors `commands.rs`'s
    // "broadcast only to the originating window" discipline (`emit_to`,
    // not a global `emit`), so a second window's agent sessions never leak
    // events into this one. `threadId` on every envelope is what then lets
    // one window's several threads share the single `ACP_EVENT` name
    // without their events getting mixed up in `lib/acp.ts`.
    let app = window.app_handle().clone();
    let forward_label = label.clone();
    let forward_thread_id = thread_id.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            let envelope = AcpEventEnvelope { thread_id: forward_thread_id.clone(), event: event.into() };
            if let Err(e) = app.emit_to(&forward_label, ACP_EVENT, envelope) {
                eprintln!("[acp] failed to emit {ACP_EVENT} to {forward_label}: {e}");
            }
        }
    });

    state.acp_sessions.lock().await.insert(key, AcpSession { client, session_id });
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn acp_stop(window: Window, state: State<'_, AppDocState>, thread_id: String) -> Result<(), String> {
    stop_session(&state, &acp_key(window.label(), &thread_id)).await;
    Ok(())
}

/// Sends one user turn and resolves once the agent's turn fully ends. This
/// can take a while — the whole point of `AcpClient` clones sharing their
/// `Arc`-wrapped internals (see its doc comment) is that this can run
/// without holding `acp_sessions`'s lock for its entire duration, so
/// `acp_stop`/a concurrent `acp_start` for the same thread (or any other
/// thread's own commands) aren't blocked behind it. The turn's streamed
/// content arrives separately, as `acp://event` `"update"` events, for as
/// long as this call is pending.
#[tauri::command(rename_all = "camelCase")]
pub async fn acp_send_prompt(window: Window, state: State<'_, AppDocState>, thread_id: String, text: String) -> Result<JsonValue, String> {
    let key = acp_key(window.label(), &thread_id);
    let sessions = state.acp_sessions.lock().await;
    let session = sessions.get(&key).ok_or_else(|| "no agent session — call acp_start first".to_string())?;
    let client = session.client.clone();
    let session_id = session.session_id.clone();
    drop(sessions);

    client.prompt(&session_id, &text).await.map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn acp_cancel(window: Window, state: State<'_, AppDocState>, thread_id: String) -> Result<(), String> {
    let key = acp_key(window.label(), &thread_id);
    let sessions = state.acp_sessions.lock().await;
    let session = sessions.get(&key).ok_or_else(|| "no agent session".to_string())?;
    session.client.cancel(&session.session_id).await.map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn acp_respond_permission(
    window: Window,
    state: State<'_, AppDocState>,
    thread_id: String,
    request_id: JsonValue,
    outcome: JsonValue,
) -> Result<(), String> {
    let key = acp_key(window.label(), &thread_id);
    let sessions = state.acp_sessions.lock().await;
    let session = sessions.get(&key).ok_or_else(|| "no agent session".to_string())?;
    session.client.respond_permission(request_id, outcome).await.map_err(|e| e.to_string())
}
