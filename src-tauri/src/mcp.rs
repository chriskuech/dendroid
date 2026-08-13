//! Starts/stops the in-process `dendroid-mcp` server alongside Settings'
//! "Local MCP" toggle (`SettingsPage.tsx`'s "mcp" section) — the UI for
//! this has existed since before there was a server behind it; this module
//! is what actually makes the toggle do something.
//!
//! Runs as a task inside this same process rather than a separate one
//! (unlike, say, a future standalone CLI build of `dendroid-mcp`), bound
//! to whichever session `AppDocState::primary_label` currently names, so
//! an MCP client's edits land in the exact same in-memory document the
//! open editor window is looking at.

use std::net::SocketAddr;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio_util::sync::CancellationToken;

use crate::state::{AppDocState, McpHandle};

/// Applies `enabled`/`host`/`port`/`disabled_skills`: stops whatever server
/// is currently running (if any — a config change always restarts rather
/// than trying to diff old vs. new), then starts a fresh one if `enabled`.
/// Called by the `mcp_set_config` command below whenever the frontend's
/// `settings.mcp` changes — including a "Skills" toggle, not just the
/// enabled/host/port fields the doc comment used to only mention — plus
/// once at startup if it was already on.
pub async fn apply(app: AppHandle, enabled: bool, host: String, port: u16, disabled_skills: Vec<String>) -> Result<(), String> {
    let state = app.state::<AppDocState>();

    if let Some(handle) = state.mcp_handle.lock().await.take() {
        handle.cancellation_token.cancel();
    }

    if !enabled {
        return Ok(());
    }

    let Some(primary_label) = state.primary_label.lock().await.clone() else {
        // Nothing open yet to serve — `workspace_open` re-triggers this
        // once a workspace exists (see `commands.rs`), so this isn't a
        // hard failure, just "not yet."
        return Ok(());
    };
    let sessions = state.sessions.lock().await;
    let Some(session) = sessions.get(&primary_label) else {
        return Err(format!("primary session {primary_label} not found"));
    };
    let doc = session.doc.clone();
    let sql = session.sql.clone();
    drop(sessions);

    let addr: SocketAddr = format!("{host}:{port}").parse().map_err(|e| format!("invalid host/port: {e}"))?;
    let listener = dendroid_mcp::bind(addr).await.map_err(|e| format!("failed to bind {addr}: {e}"))?;

    let cancellation_token = CancellationToken::new();
    let serve_token = cancellation_token.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = dendroid_mcp::serve_on(doc, sql, listener, serve_token, disabled_skills).await {
            eprintln!("[mcp] server error: {e}");
        }
    });

    *state.mcp_handle.lock().await = Some(McpHandle { cancellation_token });
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn mcp_set_config(app: AppHandle, enabled: bool, host: String, port: u16, disabled_skills: Vec<String>) -> Result<(), String> {
    apply(app, enabled, host, port, disabled_skills).await
}

/// One entry in the "Skills" section's catalog — just enough for Settings
/// to render a name/description row per tool. `mcp_list_skills` returns
/// the whole catalog regardless of "Local MCP" being enabled or which
/// skills are currently disabled, so the section is browsable/configurable
/// even before the server's ever been turned on.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
}

#[tauri::command]
pub fn mcp_list_skills() -> Vec<SkillInfo> {
    dendroid_mcp::DendroidMcpServer::tool_catalog()
        .into_iter()
        .map(|tool| SkillInfo { name: tool.name.into_owned(), description: tool.description.map(|d| d.into_owned()).unwrap_or_default() })
        .collect()
}
