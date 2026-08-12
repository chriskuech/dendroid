//! Tauri command surface. Kept thin: every command just decodes/encodes at
//! the IPC boundary and delegates to `dendroid_core::native::NativeDocument`,
//! which is where the actual CRDT/ledger logic lives. Commands are `async`
//! because opening/importing into that document goes through `LedgerStorage`
//! (real file I/O), which `dendroid_core` exposes as an async API so the
//! same code also works against the web build's OPFS-backed storage.
//!
//! There's no structural mutation command surface (no create/rename/move/
//! delete-node commands) — the document *is* what TipTap edits directly
//! through `loro-prosemirror`, and the heading tree is derived from it on
//! read (`doc_outline`). The only way this process's doc changes is
//! `doc_import_update`, merging whatever the frontend's own Loro mirror
//! already computed from a normal editing transaction.
//!
//! Every command that *can* change the document broadcasts the same way
//! afterwards: a `crdt://update` event carrying an encoded delta. That
//! keeps "how the frontend mirror stays current" a single code path
//! instead of one for command responses and another for background sync.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use dendroid_core::HeadingDto;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, Window};
use tokio::sync::Mutex;

use crate::state::{AppDocState, Session};

pub const UPDATE_EVENT: &str = "crdt://update";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UpdatePayload {
    update_b64: String,
}

/// Sends an update to one window only (its `label`) — each window has its
/// own document session (see `state::AppDocState`), so broadcasting here
/// would hand one window's edits to every other open workspace too.
pub fn emit_update(app: &AppHandle, label: &str, bytes: Vec<u8>) {
    if bytes.is_empty() {
        return;
    }
    if let Err(e) = app.emit_to(label, UPDATE_EVENT, UpdatePayload { update_b64: STANDARD.encode(bytes) }) {
        eprintln!("[crdt] failed to emit {UPDATE_EVENT} to {label}: {e}");
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOpenResult {
    /// Full Loro snapshot, base64-encoded, for bootstrapping the
    /// frontend's own `LoroDoc` mirror (`doc.import(bytes)`).
    snapshot_b64: String,
}

#[tauri::command]
pub async fn workspace_open(
    window: Window,
    state: State<'_, AppDocState>,
    root: String,
) -> Result<WorkspaceOpenResult, String> {
    let path = PathBuf::from(&root);
    let mut doc = dendroid_core::native::open_native(&path, state.session_id.clone()).await.map_err(|e| e.to_string())?;
    let snapshot = doc.export_snapshot_for_bootstrap().map_err(|e| e.to_string())?;

    let label = window.label().to_string();
    let mut sessions = state.sessions.lock().await;
    sessions.insert(label.clone(), Session { doc: Arc::new(Mutex::new(doc)) });
    drop(sessions);

    // Whichever window opens a workspace first in this process's lifetime
    // is what the local MCP server (if enabled) operates on — see
    // `state::AppDocState::primary_label`.
    let mut primary = state.primary_label.lock().await;
    if primary.is_none() {
        *primary = Some(label);
    }

    Ok(WorkspaceOpenResult { snapshot_b64: STANDARD.encode(snapshot) })
}

/// Opens a second, independent window ("File > Open Workspace in New
/// Window") pointed at `root` — separate `WorkspaceOnboarding`/workspace
/// state on the frontend (it reads the root back out of
/// `window.__DENDROID_INITIAL_WORKSPACE_ROOT__`, seeded below), and a
/// separate document session on this side once that window calls
/// `workspace_open` for itself (see `AppDocState::sessions`).
#[tauri::command]
pub async fn open_workspace_window(app: AppHandle, root: String) -> Result<(), String> {
    let label = format!("workspace-{}", uuid::Uuid::new_v4());
    // JSON-encoded so the path round-trips exactly regardless of quotes,
    // backslashes, or non-ASCII characters in it.
    let root_json = serde_json::to_string(&root).map_err(|e| e.to_string())?;

    WebviewWindowBuilder::new(&app, label, WebviewUrl::App("index.html".into()))
        .title("dendroid")
        .inner_size(800.0, 600.0)
        .initialization_script(format!("window.__DENDROID_INITIAL_WORKSPACE_ROOT__ = {root_json};"))
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Looks up `label`'s session and hands back a clone of its `Arc`-wrapped
/// doc — every command below needs this same lookup before it can lock the
/// doc itself, so it's factored out rather than repeated five times.
async fn session_doc(state: &AppDocState, label: &str) -> Result<Arc<Mutex<dendroid_core::native::NativeDocument>>, String> {
    let sessions = state.sessions.lock().await;
    sessions.get(label).map(|s| s.doc.clone()).ok_or_else(|| "no workspace open".to_string())
}

/// Headless heading outline, derived from the document. The live UI reads
/// this straight out of its own Loro mirror instead (see
/// `lib/crdt/document.ts`'s `snapshotOutline`, to avoid a round trip on
/// every keystroke) — this command exists for parity, tests, and future
/// headless consumers (CLI export, an MCP server) that don't have a
/// frontend mirror to ask.
#[tauri::command]
pub async fn doc_outline(window: Window, state: State<'_, AppDocState>) -> Result<Vec<HeadingDto>, String> {
    let doc = session_doc(&state, window.label()).await?;
    let doc = doc.lock().await;
    doc.outline().map_err(|e| e.to_string())
}

/// Receives a Loro update exported from the frontend's own `LoroDoc`
/// mirror (via `doc.subscribeLocalUpdates` — every local edit made
/// through TipTap), merges it into the authoritative Rust doc, and
/// appends it to this session's ledger file.
///
/// Uses `import_from_frontend` rather than `import_foreign_update` — this
/// update *is* this window's own edit, so the broadcast below must not
/// echo it back to the frontend that just sent it (see that method's doc
/// comment for why: `loro-prosemirror` can't distinguish an echo from a
/// real remote change, so it would rebuild the whole ProseMirror document
/// out from under whatever the user is still typing).
#[tauri::command(rename_all = "camelCase")]
pub async fn doc_import_update(window: Window, state: State<'_, AppDocState>, update_b64: String) -> Result<(), String> {
    let bytes = STANDARD.decode(&update_b64).map_err(|e| e.to_string())?;
    let label = window.label().to_string();
    let doc_handle = session_doc(&state, &label).await?;

    let mut doc = doc_handle.lock().await;
    doc.import_from_frontend(&bytes).await.map_err(|e| e.to_string())?;
    let delta = doc.export_updates_for_frontend().map_err(|e| e.to_string())?;
    drop(doc);

    if let Some(bytes) = delta {
        emit_update(window.app_handle(), &label, bytes);
    }
    Ok(())
}

/// Markdown for a slice of the document — see `dendroid_core::markdown::
/// resolve_slice` for exactly what "slice" means. The same primitive
/// MCP's `getTree` wraps (see `crate::mcp`), exposed here too for parity/
/// tests without needing an MCP connection of its own.
#[tauri::command(rename_all = "camelCase")]
pub async fn doc_get_tree(
    window: Window,
    state: State<'_, AppDocState>,
    root_id: Option<String>,
    depth: u32,
    expand_links: bool,
    link_depth: u32,
) -> Result<String, String> {
    let doc = session_doc(&state, window.label()).await?;
    let doc = doc.lock().await;
    doc.get_tree(root_id.as_deref(), depth, expand_links, link_depth).map_err(|e| e.to_string())
}

/// Parses markdown and appends it inside `target_id`'s section — see
/// `dendroid_core::markdown::apply_markdown`. Broadcasts the resulting
/// delta the same way `doc_import_update` does, so the live editor picks
/// up whatever this command (or an MCP client calling the equivalent
/// `insert` tool against the same session) just wrote.
#[tauri::command(rename_all = "camelCase")]
pub async fn doc_insert(window: Window, state: State<'_, AppDocState>, target_id: String, content: String) -> Result<(), String> {
    let label = window.label().to_string();
    let doc_handle = session_doc(&state, &label).await?;

    let mut doc = doc_handle.lock().await;
    doc.insert(&target_id, &content).await.map_err(|e| e.to_string())?;
    let delta = doc.export_updates_for_frontend().map_err(|e| e.to_string())?;
    drop(doc);

    if let Some(bytes) = delta {
        emit_update(window.app_handle(), &label, bytes);
    }
    Ok(())
}

/// Parses markdown and replaces `target_id`'s whole section body with it —
/// see `dendroid_core::markdown::apply_markdown`. Same broadcast shape as
/// `doc_insert`.
#[tauri::command(rename_all = "camelCase")]
pub async fn doc_replace_content(
    window: Window,
    state: State<'_, AppDocState>,
    target_id: String,
    content: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    let doc_handle = session_doc(&state, &label).await?;

    let mut doc = doc_handle.lock().await;
    doc.replace_content(&target_id, &content).await.map_err(|e| e.to_string())?;
    let delta = doc.export_updates_for_frontend().map_err(|e| e.to_string())?;
    drop(doc);

    if let Some(bytes) = delta {
        emit_update(window.app_handle(), &label, bytes);
    }
    Ok(())
}
