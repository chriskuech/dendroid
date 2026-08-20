//! Debounced writers for Settings' "Storage > Materialize" switches — see
//! `state::MaterializeConfig`. Turning a switch on immediately schedules a
//! write of that plain-file projection
//! (`dendroid_core::doc::DendroidDocument::materialize_markdown` /
//! `dendroid_core::sqldb::SqlWorkspace::materialize_to`) for every
//! currently open workspace; after that, every doc/db-mutating command
//! (`commands.rs`) and the ledger-poll thread (`lib.rs`, for changes
//! picked up from another session/replica) calls
//! `schedule_markdown`/`schedule_dbs` again to keep it current.
//!
//! Debounced rather than written synchronously on every change: an editing
//! session can produce many doc/db writes a second (every keystroke, for
//! the markdown side), and materializing is a full re-render/re-`VACUUM`
//! of everything, not an incremental patch — writing it out on every
//! single change would make editing itself janky for a projection nothing
//! in the app actually reads back. `DEBOUNCE` is how long a workspace has
//! to stay quiet before the write actually happens; a new call before that
//! elapses resets the wait rather than queuing a second write behind it.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::state::{AppDocState, MaterializeConfig};

/// How long a workspace has to go quiet before a scheduled materialize
/// actually runs — see the module doc comment.
const DEBOUNCE: Duration = Duration::from_millis(2000);

#[derive(Clone, Copy)]
enum Target {
    Markdown,
    Dbs,
}

impl Target {
    fn key_suffix(self) -> &'static str {
        match self {
            Target::Markdown => "markdown",
            Target::Dbs => "dbs",
        }
    }
}

/// Schedules a debounced materialize of `label`'s markdown tree — a no-op
/// if "Storage > Materialize > Markdown" is currently off.
pub fn schedule_markdown(app: &AppHandle, label: &str) {
    schedule(app.clone(), label.to_string(), Target::Markdown);
}

/// Schedules a debounced materialize of `label`'s databases — a no-op if
/// "Storage > Materialize > DBs" is currently off.
pub fn schedule_dbs(app: &AppHandle, label: &str) {
    schedule(app.clone(), label.to_string(), Target::Dbs);
}

/// The actual debounce: bumps a per-`(label, target)` generation counter
/// and sleeps `DEBOUNCE`, then only writes if nothing bumped that same
/// counter again in the meantime. A burst of N calls inside one `DEBOUNCE`
/// window therefore produces exactly one write (from the last call), not
/// N — every earlier call's sleep wakes up, sees a newer generation than
/// the one it captured, and quietly does nothing, trusting the last call's
/// own (still-pending) sleep to do the write instead.
fn schedule(app: AppHandle, label: String, target: Target) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppDocState>();
        let config = *state.materialize_config.lock().await;
        let enabled = match target {
            Target::Markdown => config.markdown,
            Target::Dbs => config.dbs,
        };
        if !enabled {
            return;
        }

        let key = format!("{label}:{}", target.key_suffix());
        let counter = {
            let mut generations = state.materialize_generations.lock().await;
            generations.entry(key).or_insert_with(|| Arc::new(AtomicU64::new(0))).clone()
        };
        let this_gen = counter.fetch_add(1, Ordering::SeqCst) + 1;

        tokio::time::sleep(DEBOUNCE).await;

        if counter.load(Ordering::SeqCst) != this_gen {
            return;
        }

        let sessions = state.sessions.lock().await;
        let Some(session) = sessions.get(&label) else { return };
        let root = session.root.clone();
        let doc = session.doc.clone();
        let sql = session.sql.clone();
        drop(sessions);

        match target {
            Target::Markdown => {
                let rendered = {
                    let doc = doc.lock().await;
                    doc.materialize_markdown()
                };
                match rendered {
                    Ok(text) => {
                        if let Err(e) = tokio::fs::write(root.join("materialized.md"), text).await {
                            eprintln!("[materialize] failed to write materialized.md: {e}");
                        }
                    }
                    Err(e) => eprintln!("[materialize] failed to render markdown: {e}"),
                }
            }
            Target::Dbs => {
                let sql = sql.lock().await;
                let dir = root.join("materialized-dbs");
                if let Err(e) = sql.materialize_to(&dir) {
                    eprintln!("[materialize] failed to write databases: {e}");
                }
            }
        }
    });
}

/// Applies Settings' "Storage > Materialize" switches: stores the new
/// config, then immediately schedules a (still-debounced) materialize of
/// whichever half is on, for every currently open workspace — otherwise a
/// switch flipped on wouldn't produce a file until the next doc/db write
/// happened to come along. Rescheduling a half that was already on is
/// harmless (worst case, one extra write); far simpler than diffing
/// against the previous config to only reschedule what actually changed.
#[tauri::command(rename_all = "camelCase")]
pub async fn materialize_set_config(app: AppHandle, markdown: bool, dbs: bool) -> Result<(), String> {
    let state = app.state::<AppDocState>();
    *state.materialize_config.lock().await = MaterializeConfig { markdown, dbs };

    let labels: Vec<String> = state.sessions.lock().await.keys().cloned().collect();
    for label in labels {
        if markdown {
            schedule_markdown(&app, &label);
        }
        if dbs {
            schedule_dbs(&app, &label);
        }
    }
    Ok(())
}
