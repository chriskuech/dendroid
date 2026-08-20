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
use dendroid_core::{
    ColumnDto, DatabaseDto, DbHistoryEntryDto, EncryptionStatusDto, HeadingDto, HistoryEntryDto, QueryResultDto,
    TableDto, TableRowsDto,
};
use serde::Serialize;
use serde_json::Value as JsonValue;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, Window};
use tokio::sync::Mutex;

use crate::automation::AutomationEngine;
use crate::state::{AppDocState, Session};

pub const UPDATE_EVENT: &str = "crdt://update";

/// Broadcast whenever a window's SQL databases change — a mutation this
/// window made itself (`db_create`/`db_delete`/`db_exec`/`db_revert_to`),
/// or one the ledger-poll thread in `lib.rs` picked up from another
/// session/replica. No payload beyond which database changed: unlike
/// `crdt://update`, there's no CRDT delta to hand the frontend — a
/// `DatabaseView` that's currently open just re-fetches whatever it's
/// showing (mirrors how `HistoryView.tsx` already reacts to `crdt`'s own
/// `onUpdate` by re-fetching rather than diffing).
pub const DB_UPDATE_EVENT: &str = "db://update";

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

/// See `DB_UPDATE_EVENT`.
pub fn emit_db_update(app: &AppHandle, label: &str) {
    if let Err(e) = app.emit_to(label, DB_UPDATE_EVENT, ()) {
        eprintln!("[sqldb] failed to emit {DB_UPDATE_EVENT} to {label}: {e}");
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
    let sql = dendroid_core::native::open_native_sql(&path, state.session_id.clone()).await.map_err(|e| e.to_string())?;

    let label = window.label().to_string();
    let mut sessions = state.sessions.lock().await;
    sessions.insert(label.clone(), Session { doc: Arc::new(Mutex::new(doc)), sql: Arc::new(Mutex::new(sql)), root: path.clone() });
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

/// Same lookup as `session_doc`, for the SQL database store.
async fn session_sql(state: &AppDocState, label: &str) -> Result<Arc<Mutex<dendroid_core::native::NativeSqlWorkspace>>, String> {
    let sessions = state.sessions.lock().await;
    sessions.get(label).map(|s| s.sql.clone()).ok_or_else(|| "no workspace open".to_string())
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
    crate::materialize::schedule_markdown(window.app_handle(), &label);
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
    crate::materialize::schedule_markdown(window.app_handle(), &label);
    Ok(())
}

/// Every change in this session's document history, most recent first —
/// see `dendroid_core::history::history`. What the History panel lists.
#[tauri::command(rename_all = "camelCase")]
pub async fn doc_history(window: Window, state: State<'_, AppDocState>) -> Result<Vec<HistoryEntryDto>, String> {
    let doc = session_doc(&state, window.label()).await?;
    let doc = doc.lock().await;
    doc.history().map_err(|e| e.to_string())
}

/// Rolls the document back to `token` (a `HistoryEntryDto.token` from a
/// previous `doc_history` call) — see `dendroid_core::history::revert_to`.
/// Same broadcast shape as `doc_insert`/`doc_replace_content`: the frontend
/// mirror doesn't apply the rollback itself, it just picks up the delta
/// this emits over `crdt://update` like any other backend-driven change.
#[tauri::command(rename_all = "camelCase")]
pub async fn doc_revert_to(window: Window, state: State<'_, AppDocState>, token: String) -> Result<(), String> {
    let label = window.label().to_string();
    let doc_handle = session_doc(&state, &label).await?;

    let mut doc = doc_handle.lock().await;
    doc.revert_to(&token).await.map_err(|e| e.to_string())?;
    let delta = doc.export_updates_for_frontend().map_err(|e| e.to_string())?;
    drop(doc);

    if let Some(bytes) = delta {
        emit_update(window.app_handle(), &label, bytes);
    }
    crate::materialize::schedule_markdown(window.app_handle(), &label);
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
    crate::materialize::schedule_markdown(window.app_handle(), &label);
    Ok(())
}

// --- Encryption ------------------------------------------------------
//
// See `dendroid_core::doc::DendroidDocument`'s own "Encryption" section
// for what each of these actually does; these are thin decode/delegate
// wrappers, same shape as `doc_*` above. `encryption_generate_key` and
// `encryption_set_key` can both change the live document (draining
// records that were previously blocked — see `DendroidDocument::
// drain_pending`), so both broadcast afterward exactly like `doc_import_
// update` does.

/// Wire shape for `encryption_generate_key`'s response — `keyText` is what
/// the caller offers immediately as a QR code / copy-paste target.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateKeyResult {
    key_text: String,
    status: EncryptionStatusDto,
}

/// Current encryption state — whether a key is set, its fingerprint, and
/// why sync is blocked (if it is). What Settings' encryption panel polls/
/// reads to render.
#[tauri::command(rename_all = "camelCase")]
pub async fn encryption_status(window: Window, state: State<'_, AppDocState>) -> Result<EncryptionStatusDto, String> {
    let doc = session_doc(&state, window.label()).await?;
    let doc = doc.lock().await;
    Ok(doc.encryption_status())
}

/// Turns on encryption with a freshly generated key — "create a key", one
/// of the two choices the enable-encryption prompt offers.
#[tauri::command(rename_all = "camelCase")]
pub async fn encryption_generate_key(window: Window, state: State<'_, AppDocState>) -> Result<GenerateKeyResult, String> {
    let label = window.label().to_string();
    let doc_handle = session_doc(&state, &label).await?;

    let mut doc = doc_handle.lock().await;
    let (key_text, status) = doc.generate_encryption_key().await.map_err(|e| e.to_string())?;
    let delta = doc.export_updates_for_frontend().map_err(|e| e.to_string())?;
    drop(doc);

    if let Some(bytes) = delta {
        emit_update(window.app_handle(), &label, bytes);
    }
    Ok(GenerateKeyResult { key_text, status })
}

/// Turns on encryption with `key_text` — the other half of the
/// enable-encryption prompt ("add one from a QR code"), a scanned QR's
/// decoded contents, or a pasted textual key. Also how the frontend
/// re-supplies a previously-generated key at every app start (see `lib/
/// crdt/document.ts`) — idempotent, since `DendroidDocument::
/// set_encryption_key` has nothing left to encrypt once everything already
/// is.
#[tauri::command(rename_all = "camelCase")]
pub async fn encryption_set_key(window: Window, state: State<'_, AppDocState>, key_text: String) -> Result<EncryptionStatusDto, String> {
    let label = window.label().to_string();
    let doc_handle = session_doc(&state, &label).await?;

    let mut doc = doc_handle.lock().await;
    let status = doc.set_encryption_key(&key_text).await.map_err(|e| e.to_string())?;
    let delta = doc.export_updates_for_frontend().map_err(|e| e.to_string())?;
    drop(doc);

    if let Some(bytes) = delta {
        emit_update(window.app_handle(), &label, bytes);
    }
    Ok(status)
}

/// Turns encryption off on this device — see `DendroidDocument::
/// remove_encryption_key`'s doc comment for what does (and, importantly,
/// doesn't) happen to history already encrypted with the removed key.
#[tauri::command(rename_all = "camelCase")]
pub async fn encryption_remove_key(window: Window, state: State<'_, AppDocState>) -> Result<(), String> {
    let doc = session_doc(&state, window.label()).await?;
    let mut doc = doc.lock().await;
    doc.remove_encryption_key();
    Ok(())
}

// --- SQL databases -------------------------------------------------------
//
// See `dendroid_core::sqldb` for the actual logic — everything below is
// the same thin decode/delegate/broadcast shape `doc_*` above already
// uses, just against `Session::sql` instead of `Session::doc`, and
// broadcasting `DB_UPDATE_EVENT` (no delta payload — see its doc comment)
// instead of `crdt://update`.

/// Every live database in this window's workspace — what the sidebar's
/// database list renders.
#[tauri::command(rename_all = "camelCase")]
pub async fn db_list(window: Window, state: State<'_, AppDocState>) -> Result<Vec<DatabaseDto>, String> {
    let sql = session_sql(&state, window.label()).await?;
    let sql = sql.lock().await;
    Ok(sql.list_databases())
}

/// Creates a new, empty database and returns its fresh id.
#[tauri::command(rename_all = "camelCase")]
pub async fn db_create(window: Window, state: State<'_, AppDocState>, name: String) -> Result<String, String> {
    let label = window.label().to_string();
    let sql_handle = session_sql(&state, &label).await?;

    let mut sql = sql_handle.lock().await;
    let id = sql.create_database(&name).await.map_err(|e| e.to_string())?;
    drop(sql);

    emit_db_update(window.app_handle(), &label);
    crate::materialize::schedule_dbs(window.app_handle(), &label);
    Ok(id)
}

/// Removes a database from the live set.
#[tauri::command(rename_all = "camelCase")]
pub async fn db_delete(window: Window, state: State<'_, AppDocState>, id: String) -> Result<(), String> {
    let label = window.label().to_string();
    let sql_handle = session_sql(&state, &label).await?;

    let mut sql = sql_handle.lock().await;
    sql.delete_database(&id).await.map_err(|e| e.to_string())?;
    drop(sql);

    emit_db_update(window.app_handle(), &label);
    crate::materialize::schedule_dbs(window.app_handle(), &label);
    Ok(())
}

/// Runs one statement (or, if `batch`, a `;`-separated script) against
/// `id` and ledgers it — see `dendroid_core::sqldb::SqlWorkspace::exec`.
/// What every basic-table-UI action (insert/update/delete a row, create/
/// alter/drop a table) and the "Run SQL" console both go through.
///
/// Also the data-trigger engine's only hook into database writes: after a
/// successful non-batch statement, `crate::automation::detect_write` makes
/// a best-effort guess at which table/row-change kind it was and, if it
/// matches a configured automation's `data` watch, fires it
/// (`crate::automation::fire_data_triggers`). Batch statements (the "Run
/// SQL" console's multi-statement path) are skipped entirely — see
/// `detect_write`'s doc comment for why one statement's shape is as far as
/// this goes.
#[tauri::command(rename_all = "camelCase")]
pub async fn db_exec(
    window: Window,
    state: State<'_, AppDocState>,
    engine: State<'_, AutomationEngine>,
    id: String,
    sql: String,
    params: Option<Vec<JsonValue>>,
    batch: Option<bool>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let sql_handle = session_sql(&state, &label).await?;
    let is_batch = batch.unwrap_or(false);
    let bound_params = params.unwrap_or_default();

    let mut db = sql_handle.lock().await;
    db.exec(&id, &sql, bound_params.clone(), is_batch).await.map_err(|e| e.to_string())?;
    drop(db);

    emit_db_update(window.app_handle(), &label);
    crate::materialize::schedule_dbs(window.app_handle(), &label);

    if !is_batch {
        if let Some((event, table)) = crate::automation::detect_write(&sql) {
            crate::automation::fire_data_triggers(window.app_handle().clone(), &engine, &id, &table, &event, bound_params).await;
        }
    }
    Ok(())
}

/// Every user table in `id`, with its columns — what the database view's
/// table list renders.
#[tauri::command(rename_all = "camelCase")]
pub async fn db_tables(window: Window, state: State<'_, AppDocState>, id: String) -> Result<Vec<TableDto>, String> {
    let sql = session_sql(&state, window.label()).await?;
    let sql = sql.lock().await;
    sql.list_tables(&id).map_err(|e| e.to_string())
}

/// A columns-and-column-metadata description of `table` alone, without
/// paging through its rows. The live UI doesn't call this today — it
/// already gets column metadata for free from `db_tables` (the table
/// strip) and `db_table_rows` (the grid) — but it's a cheaper primitive
/// than a full `db_table_rows` round trip for anything that only needs a
/// schema (e.g. a future "add row" form built before any rows exist).
/// Same "exists for parity/future headless consumers" reasoning as
/// `doc_outline`.
#[tauri::command(rename_all = "camelCase")]
pub async fn db_table_columns(window: Window, state: State<'_, AppDocState>, id: String, table: String) -> Result<Vec<ColumnDto>, String> {
    let sql = session_sql(&state, window.label()).await?;
    let sql = sql.lock().await;
    let tables = sql.list_tables(&id).map_err(|e| e.to_string())?;
    tables.into_iter().find(|t| t.name == table).map(|t| t.columns).ok_or_else(|| format!("table {table:?} not found"))
}

/// A page of `table`'s rows in `id` — what the database view's data grid
/// renders. `orderBy`/`orderDesc` back the grid's clickable column-header
/// sort; omitted, it's `rowid`-ordered same as before. See
/// `dendroid_core::sqldb::SqlWorkspace::table_rows`.
#[tauri::command(rename_all = "camelCase")]
pub async fn db_table_rows(
    window: Window,
    state: State<'_, AppDocState>,
    id: String,
    table: String,
    limit: u32,
    offset: u32,
    order_by: Option<String>,
    order_desc: Option<bool>,
) -> Result<TableRowsDto, String> {
    let sql = session_sql(&state, window.label()).await?;
    let sql = sql.lock().await;
    sql.table_rows(&id, &table, limit, offset, order_by.as_deref(), order_desc.unwrap_or(false)).map_err(|e| e.to_string())
}

/// Runs a single read-only statement (`SELECT`/`PRAGMA`/`EXPLAIN`/...)
/// against `id` and returns whatever it selected — the SQL editor's "run
/// as a query" path. Not ledgered (see
/// `dendroid_core::sqldb::SqlWorkspace::query`), so unlike `db_exec` this
/// never broadcasts `DB_UPDATE_EVENT`: nothing about `id` actually
/// changed.
#[tauri::command(rename_all = "camelCase")]
pub async fn db_query(window: Window, state: State<'_, AppDocState>, id: String, sql: String) -> Result<QueryResultDto, String> {
    let workspace = session_sql(&state, window.label()).await?;
    let workspace = workspace.lock().await;
    workspace.query(&id, &sql).map_err(|e| e.to_string())
}

/// `id`'s change history, most recent first — what the History sidebar
/// tab shows while a database (rather than the tree) is open.
#[tauri::command(rename_all = "camelCase")]
pub async fn db_history(window: Window, state: State<'_, AppDocState>, id: String) -> Result<Vec<DbHistoryEntryDto>, String> {
    let sql = session_sql(&state, window.label()).await?;
    let sql = sql.lock().await;
    sql.history(&id).map_err(|e| e.to_string())
}

/// Rolls `id` back to `token` (a `DbHistoryEntryDto.token` from a previous
/// `db_history` call) — see `dendroid_core::sqldb::SqlWorkspace::revert_to`.
#[tauri::command(rename_all = "camelCase")]
pub async fn db_revert_to(window: Window, state: State<'_, AppDocState>, id: String, token: String) -> Result<(), String> {
    let label = window.label().to_string();
    let sql_handle = session_sql(&state, &label).await?;

    let mut sql = sql_handle.lock().await;
    sql.revert_to(&id, &token).await.map_err(|e| e.to_string())?;
    drop(sql);

    emit_db_update(window.app_handle(), &label);
    crate::materialize::schedule_dbs(window.app_handle(), &label);
    Ok(())
}
