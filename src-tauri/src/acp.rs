//! Bridges the Agent chat drawer (`components/agent/AgentPanel.tsx`) to a
//! spawned ACP-speaking agent subprocess via `dendroid_acp`. One agent
//! session per *window* (`state::AppDocState::acp_sessions`, keyed by
//! window label — same convention `state::AppDocState::sessions` uses),
//! started on demand rather than automatically: unlike "Local MCP", there's
//! no Settings toggle that starts this on its own — the drawer calls
//! `acp_start` itself the first time it needs a connection (see
//! `lib/acp.ts`'s `startAgent`).
//!
//! Every command here just looks its window's session up and delegates to
//! `dendroid_acp::AcpClient` — the protocol/process-management logic all
//! lives in that crate, same "thin IPC boundary" shape `commands.rs` uses
//! for the document commands.

use dendroid_acp::{AcpClient, AcpEvent};
use serde::Serialize;
use serde_json::Value as JsonValue;
use tauri::{Emitter, Manager, State, Window};

use crate::state::{AcpSession, AppDocState};

/// Emitted to a window for every event its agent session produces —
/// streamed `session/update` content, a `session/request_permission` ask,
/// or the agent process closing. See `lib/acp.ts`'s `onAgentEvent`.
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

/// Tears down whatever agent session `label`'s window already has, if any
/// — used both by `acp_stop` and by `acp_start` itself (see its doc
/// comment for why starting always restarts) and by `lib.rs`'s
/// `on_window_event` when that window closes.
pub async fn stop_session(state: &AppDocState, label: &str) {
    if let Some(session) = state.acp_sessions.lock().await.remove(label) {
        session.client.shutdown().await;
    }
}

/// Starts (or restarts) this window's agent session: spawns `command args`
/// with `cwd` as its working directory, completes the ACP handshake, and
/// opens a session. Always tears down whatever session this window already
/// had first — same "a config change always restarts rather than trying to
/// diff old vs. new" rule `mcp::apply` follows, since there's no cheap way
/// to tell whether `command`/`args` changed since the last connection.
#[tauri::command(rename_all = "camelCase")]
pub async fn acp_start(window: Window, state: State<'_, AppDocState>, command: String, args: Vec<String>, cwd: String) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("no agent command configured — set one in Settings".to_string());
    }

    let label = window.label().to_string();
    stop_session(&state, &label).await;

    let (client, mut events) = AcpClient::spawn(&command, &args, &cwd).await.map_err(|e| e.to_string())?;
    let session_id = client.new_session(&cwd).await.map_err(|e| e.to_string())?;

    // Forwards every event for this session to its own window, for as long
    // as the session lives — mirrors `commands.rs`'s "broadcast only to the
    // originating window" discipline (`emit_to`, not a global `emit`), so a
    // second window's agent session never leaks events into this one.
    let app = window.app_handle().clone();
    let forward_label = label.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            let payload: AcpEventPayload = event.into();
            if let Err(e) = app.emit_to(&forward_label, ACP_EVENT, payload) {
                eprintln!("[acp] failed to emit {ACP_EVENT} to {forward_label}: {e}");
            }
        }
    });

    state.acp_sessions.lock().await.insert(label, AcpSession { client, session_id });
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn acp_stop(window: Window, state: State<'_, AppDocState>) -> Result<(), String> {
    stop_session(&state, window.label()).await;
    Ok(())
}

/// Sends one user turn and resolves once the agent's turn fully ends. This
/// can take a while — the whole point of `AcpClient` clones sharing their
/// `Arc`-wrapped internals (see its doc comment) is that this can run
/// without holding `acp_sessions`'s lock for its entire duration, so
/// `acp_stop`/a concurrent `acp_start` for the same window aren't blocked
/// behind it. The turn's streamed content arrives separately, as `acp://event`
/// `"update"` events, for as long as this call is pending.
#[tauri::command(rename_all = "camelCase")]
pub async fn acp_send_prompt(window: Window, state: State<'_, AppDocState>, text: String) -> Result<JsonValue, String> {
    let sessions = state.acp_sessions.lock().await;
    let session = sessions.get(window.label()).ok_or_else(|| "no agent session — call acp_start first".to_string())?;
    let client = session.client.clone();
    let session_id = session.session_id.clone();
    drop(sessions);

    client.prompt(&session_id, &text).await.map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn acp_cancel(window: Window, state: State<'_, AppDocState>) -> Result<(), String> {
    let sessions = state.acp_sessions.lock().await;
    let session = sessions.get(window.label()).ok_or_else(|| "no agent session".to_string())?;
    session.client.cancel(&session.session_id).await.map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn acp_respond_permission(window: Window, state: State<'_, AppDocState>, request_id: JsonValue, outcome: JsonValue) -> Result<(), String> {
    let sessions = state.acp_sessions.lock().await;
    let session = sessions.get(window.label()).ok_or_else(|| "no agent session".to_string())?;
    session.client.respond_permission(request_id, outcome).await.map_err(|e| e.to_string())
}
