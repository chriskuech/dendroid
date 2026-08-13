// Platform-agnostic logic lives in the `dendroid-core` crate (src-core/).

mod acp;
mod commands;
mod mcp;
mod state;

use std::time::Duration;

use state::AppDocState;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, Runtime};

/// How often to tail the ledger directory for records written by other
/// sessions of this app or another replica of the workspace folder (e.g.
/// a second device synced via iCloud Drive). iCloud Drive/OneDrive-style
/// sync doesn't reliably fire native filesystem events, so this polls
/// rather than relying on one — see the "native sync" note in the repo
/// notes for why.
const LEDGER_POLL_INTERVAL: Duration = Duration::from_millis(1500);

/// Id of the native "Settings" menu item, matched in the `on_menu_event`
/// handler below.
const SETTINGS_MENU_ID: &str = "settings";

/// Emitted when the native "Settings" menu item is picked. The frontend
/// (`App.tsx`) listens for this and opens the same `SettingsPage` its
/// in-app settings launcher button does.
const OPEN_SETTINGS_EVENT: &str = "menu://open-settings";

/// Id of the native "New Workspace" menu item, matched in the
/// `on_menu_event` handler below.
const NEW_WORKSPACE_MENU_ID: &str = "new-workspace";

/// Emitted when the native "New Workspace" menu item is picked. The
/// frontend (`App.tsx`) listens for this and drops back into the same
/// workspace-creation flow shown on first launch (`WorkspaceOnboarding`).
const NEW_WORKSPACE_EVENT: &str = "menu://new-workspace";

/// Id of the native "Open Workspace…" menu item, matched in the
/// `on_menu_event` handler below.
const OPEN_WORKSPACE_MENU_ID: &str = "open-workspace";

/// Emitted when the native "Open Workspace…" menu item is picked. The
/// frontend (`App.tsx`) listens for this, runs the folder picker directly
/// (skipping `WorkspaceOnboarding`'s provider/name steps), and switches to
/// the chosen folder as the active workspace.
const OPEN_WORKSPACE_EVENT: &str = "menu://open-workspace";

/// Id of the native "Open Workspace in New Window…" menu item, matched in
/// the `on_menu_event` handler below.
const OPEN_WORKSPACE_NEW_WINDOW_MENU_ID: &str = "open-workspace-new-window";

/// Emitted when the native "Open Workspace in New Window…" menu item is
/// picked. The frontend (`App.tsx`) listens for this, runs the folder
/// picker, and — unlike `OPEN_WORKSPACE_EVENT` — hands the chosen path to
/// the `open_workspace_window` command instead of adopting it itself, so
/// it opens alongside the current workspace rather than replacing it (see
/// `state::AppDocState` for how the two windows' document sessions stay
/// independent).
const OPEN_WORKSPACE_NEW_WINDOW_EVENT: &str = "menu://open-workspace-new-window";

/// The app's native menu bar. Kept to the handful of items every desktop
/// app is expected to have plus our custom items ("Settings", under the
/// app submenu per platform convention, and "New Workspace"/"Open
/// Workspace…"/"Open Workspace in New Window…", under File) — there's
/// nothing here yet that warrants more than that.
fn build_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let settings = MenuItem::with_id(app, SETTINGS_MENU_ID, "Settings", true, Some("CmdOrCtrl+,"))?;
    let new_workspace =
        MenuItem::with_id(app, NEW_WORKSPACE_MENU_ID, "New Workspace", true, Some("CmdOrCtrl+N"))?;
    let open_workspace =
        MenuItem::with_id(app, OPEN_WORKSPACE_MENU_ID, "Open Workspace…", true, Some("CmdOrCtrl+O"))?;
    let open_workspace_new_window = MenuItem::with_id(
        app,
        OPEN_WORKSPACE_NEW_WINDOW_MENU_ID,
        "Open Workspace in New Window…",
        true,
        Some("CmdOrCtrl+Shift+O"),
    )?;

    let app_menu = Submenu::with_items(
        app,
        "Dendroid",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let file_menu =
        Submenu::with_items(app, "File", true, &[&new_workspace, &open_workspace, &open_workspace_new_window])?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::close_window(app, None)?],
    )?;

    Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &window_menu])
}

/// The app menu bar is one shared, process-wide menu (standard on macOS),
/// not one per window — so a menu click doesn't inherently say which of
/// several open windows it was meant for. We resolve that to whichever
/// window currently has focus and target only that one; broadcasting to
/// every window (the old behavior, back when only one window could ever
/// exist) would otherwise, e.g., pop Settings open in *all* of them at
/// once now that "File > Open Workspace in New Window" makes multiple
/// windows a real scenario.
fn focused_window_label<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<String> {
    app.webview_windows().into_iter().find(|(_, window)| window.is_focused().unwrap_or(false)).map(|(label, _)| label)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppDocState::new())
        .menu(build_menu)
        .on_menu_event(|app, event| {
            let Some(label) = focused_window_label(app) else {
                return;
            };
            let (name, result) = if event.id() == SETTINGS_MENU_ID {
                (OPEN_SETTINGS_EVENT, app.emit_to(&label, OPEN_SETTINGS_EVENT, ()))
            } else if event.id() == NEW_WORKSPACE_MENU_ID {
                (NEW_WORKSPACE_EVENT, app.emit_to(&label, NEW_WORKSPACE_EVENT, ()))
            } else if event.id() == OPEN_WORKSPACE_MENU_ID {
                (OPEN_WORKSPACE_EVENT, app.emit_to(&label, OPEN_WORKSPACE_EVENT, ()))
            } else if event.id() == OPEN_WORKSPACE_NEW_WINDOW_MENU_ID {
                (OPEN_WORKSPACE_NEW_WINDOW_EVENT, app.emit_to(&label, OPEN_WORKSPACE_NEW_WINDOW_EVENT, ()))
            } else {
                return;
            };
            if let Err(e) = result {
                eprintln!("[menu] failed to emit {name} to {label}: {e}");
            }
        })
        // Drops a closed window's document session (if it had one) so the
        // ledger-poll thread below stops polling it and `AppDocState`
        // doesn't accumulate an entry per window ever opened over the
        // process's lifetime. If that window's session was also the one
        // the local MCP server was serving, stop it too — a stale doc
        // handle isn't something an MCP client should keep silently
        // talking to; the next `workspace_open` (from any window) claims
        // "primary" again and, if "Local MCP" is still enabled in
        // Settings, `App.tsx`'s effect re-applies the config to restart it.
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let label = window.label().to_string();
                let state = window.state::<AppDocState>();
                tauri::async_runtime::block_on(async {
                    state.sessions.lock().await.remove(&label);
                    acp::stop_session(&state, &label).await;

                    let mut primary = state.primary_label.lock().await;
                    if primary.as_deref() == Some(label.as_str()) {
                        *primary = None;
                        drop(primary);
                        if let Some(handle) = state.mcp_handle.lock().await.take() {
                            handle.cancellation_token.cancel();
                        }
                    }
                });
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            // A plain OS thread, not a tokio task: `poll_external`/the
            // session lock are async (see `state::AppDocState`), so each
            // tick blocks this thread on that one `async` block via
            // tauri's runtime rather than pulling the whole loop onto the
            // tokio executor.
            std::thread::spawn(move || loop {
                std::thread::sleep(LEDGER_POLL_INTERVAL);

                // One workspace per window now (see `state::AppDocState`),
                // so this walks every open session rather than assuming a
                // single global one, and emits each session's updates only
                // to its own window.
                let (outbound, db_changed): (Vec<(String, Vec<u8>)>, Vec<String>) = tauri::async_runtime::block_on(async {
                    let state = handle.state::<AppDocState>();
                    // Clone out the `Arc` handles and drop the map lock
                    // before awaiting each one's poll, rather than holding
                    // it (and blocking every command that needs a session
                    // lookup) for the whole tick.
                    let sessions = state.sessions.lock().await;
                    let docs: Vec<(String, _, _)> =
                        sessions.iter().map(|(label, session)| (label.clone(), session.doc.clone(), session.sql.clone())).collect();
                    drop(sessions);

                    let mut outbound = Vec::new();
                    let mut db_changed = Vec::new();
                    for (label, doc, sql) in docs {
                        let mut doc = doc.lock().await;
                        match doc.poll_external().await {
                            Ok(true) => match doc.export_updates_for_frontend() {
                                Ok(Some(bytes)) => outbound.push((label.clone(), bytes)),
                                Ok(None) => {}
                                Err(e) => eprintln!("[crdt] export_updates_for_frontend failed for {label}: {e}"),
                            },
                            Ok(false) => {}
                            Err(e) => eprintln!("[crdt] poll_external failed for {label}: {e}"),
                        }
                        drop(doc);

                        let mut sql = sql.lock().await;
                        match sql.poll_external().await {
                            Ok(true) => db_changed.push(label.clone()),
                            Ok(false) => {}
                            Err(e) => eprintln!("[sqldb] poll_external failed for {label}: {e}"),
                        }
                    }
                    (outbound, db_changed)
                });

                for (label, bytes) in outbound {
                    commands::emit_update(&handle, &label, bytes);
                }
                for label in db_changed {
                    commands::emit_db_update(&handle, &label);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::workspace_open,
            commands::open_workspace_window,
            commands::doc_outline,
            commands::doc_import_update,
            commands::doc_get_tree,
            commands::doc_insert,
            commands::doc_replace_content,
            commands::doc_history,
            commands::doc_revert_to,
            commands::db_list,
            commands::db_create,
            commands::db_delete,
            commands::db_exec,
            commands::db_tables,
            commands::db_table_columns,
            commands::db_table_rows,
            commands::db_query,
            commands::db_history,
            commands::db_revert_to,
            mcp::mcp_set_config,
            acp::acp_start,
            acp::acp_stop,
            acp::acp_send_prompt,
            acp::acp_cancel,
            acp::acp_respond_permission,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
