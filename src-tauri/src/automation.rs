//! Background engine that actually fires the automations configured in the
//! Automations sidebar tab (`components/automations/*`): a cron scheduler
//! (`spawn_cron_loop`) and a best-effort database-write watcher
//! (`fire_data_triggers`, called from `commands::db_exec`). Deliberately
//! independent of any window/session — an automation isn't scoped to one
//! open workspace (see `lib/automations.ts`'s doc comment), so this can't
//! reuse `state::AppDocState::acp_sessions`'s (window, thread) keying the
//! way the chat drawer (`crate::acp`) does. Every fire spawns and tears
//! down its own `dendroid_acp::AcpClient` instead, and persists its
//! transcript to a JSON file under the app's data dir rather than
//! streaming it to a live UI — there may not be one open when a cron fire
//! happens.
//!
//! The frontend pushes its resolved skills/automations/agent-settings
//! config down via `automations_sync` (`lib/automationsEngine.ts`) — this
//! module never reads dendroid's settings store itself, the same "config
//! arrives over IPC, not read from disk" shape `crate::mcp::apply` already
//! uses.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Datelike, Local, Timelike};
use dendroid_acp::{AcpClient, AcpEvent};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::fs;
use tokio::sync::Mutex;

/// How often the cron loop wakes up to check every automation's schedule
/// against the current minute — well under 60s so no matching minute is
/// ever missed (see `cron_matches`'s minute-granularity contract) or
/// double-counted (`EngineData::last_fired_minute` still guards that too,
/// in case a tick ever lands late).
const CRON_TICK: Duration = Duration::from_secs(20);

/// How long a single fire is allowed to run before it's cancelled and
/// recorded as a timeout — guards the engine against one misbehaving agent
/// process (or one waiting forever on a permission prompt nobody's around
/// to answer — see `run_agent`'s doc comment) hanging indefinitely.
const FIRE_TIMEOUT: Duration = Duration::from_secs(300);

/// Emitted app-wide (not to one window — unlike `acp::ACP_EVENT`, nothing
/// about a background fire is tied to whichever window happens to be
/// open) whenever a run finishes, successfully or not. Payload is just
/// `{automationId, runId}`; `lib/automationsEngine.ts`'s `onAutomationRun`
/// listens for it and the Automations tab just re-fetches, same "no delta
/// payload" convention `commands::DB_UPDATE_EVENT` already uses.
const RUN_EVENT: &str = "automations://run";

/// Mirrors `lib/types.ts`'s `AutomationDataTrigger`, as sent by
/// `lib/automationsEngine.ts`'s `syncAutomationsEngine`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataTriggerDto {
    pub database_id: String,
    pub table: String,
    pub events: Vec<String>,
}

/// One automation, fully resolved — the engine never looks anything else
/// up by id (no access to dendroid's settings store), so the frontend
/// inlines the referenced skill's instructions and the configured agent
/// command/args here rather than sending ids. Disabled automations, and
/// ones with neither `cron` nor `data` set, are filtered out before this
/// ever reaches the engine (see `syncAutomationsEngine`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationSyncDto {
    pub id: String,
    pub name: String,
    /// A 5-field cron expression, or `None` if this automation doesn't run
    /// on a schedule — see `cron_matches`.
    pub cron: Option<String>,
    pub data: Option<DataTriggerDto>,
    pub skill_name: String,
    pub skill_instructions: String,
    pub agent_command: String,
    pub agent_args: Vec<String>,
}

#[derive(Default)]
struct EngineData {
    /// Working directory to spawn the agent process in — set alongside
    /// every `automations_sync` call (see `lib/automationsEngine.ts`'s
    /// `setAutomationsCwd`). `None` until a workspace has synced at least
    /// once; the cron loop and `automation_run_now` both no-op until then.
    cwd: Option<String>,
    automations: Vec<AutomationSyncDto>,
    /// Minute-truncated unix timestamp (`ts / 60`) each automation last
    /// fired its cron at, keyed by automation id — so a tick landing
    /// inside a minute that already fired doesn't fire it again. Entries
    /// for automations no longer present in `automations` are simply
    /// never read again; not worth pruning.
    last_fired_minute: HashMap<String, i64>,
}

/// The engine's process-wide state — managed alongside `state::AppDocState`
/// (see `lib.rs`'s `.manage(...)`), not part of it: unlike every field on
/// `AppDocState`, nothing here is keyed by window.
pub struct AutomationEngine {
    data: Mutex<EngineData>,
}

impl AutomationEngine {
    pub fn new() -> Self {
        Self { data: Mutex::new(EngineData::default()) }
    }
}

impl Default for AutomationEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// Mirrors `lib/types.ts`'s `AutomationEvent` — the row change (or
/// best-effort approximation of one, for a data-triggered fire; see
/// `detect_write`) that caused a run, if any. A cron-fired (or "run now"
/// with no simulated event) run has none.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationEventDto {
    pub database: String,
    pub table: String,
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Vec<JsonValue>>,
    pub fired_at: String,
}

/// One persisted run — written to
/// `{app_data_dir}/automation-runs/{automation_id}/{id}.json` by
/// `persist_run`, and read back by `automation_runs_list`/
/// `automation_run_get`. Field names/shape mirror `lib/types.ts`'s
/// `AutomationRun` exactly (via `rename_all = "camelCase"`) so the frontend
/// can deserialize `automation_run_get`'s response directly with no
/// reshaping.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub id: String,
    pub automation_id: String,
    pub automation_name: String,
    /// `"cron"`, `"data"`, or `"manual"` — see `lib/types.ts`'s
    /// `AutomationRunReason`.
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<AutomationEventDto>,
    pub fired_at: String,
    /// `"done"` or `"error"` — a `RunRecord` is only ever persisted once a
    /// fire has actually finished (see `fire_automation`), so `"running"`
    /// (a valid `AutomationRunStatus` on the frontend) never appears in a
    /// file on disk; nothing needs to poll a run "in flight".
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    pub prompt: String,
    /// Every raw `session/update` payload the agent streamed, in arrival
    /// order — see `lib/types.ts`'s `AutomationRun.updates` doc comment
    /// for how the frontend folds this back into a renderable timeline.
    pub updates: Vec<JsonValue>,
}

/// `automation_runs_list`'s response shape — `RunRecord` minus `prompt`/
/// `updates`, the two fields a run list doesn't need and a full transcript
/// would be wasteful to fetch just to render a row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunSummaryDto {
    pub id: String,
    pub automation_id: String,
    pub automation_name: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<AutomationEventDto>,
    pub fired_at: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
}

impl From<&RunRecord> for AutomationRunSummaryDto {
    fn from(r: &RunRecord) -> Self {
        Self {
            id: r.id.clone(),
            automation_id: r.automation_id.clone(),
            automation_name: r.automation_name.clone(),
            reason: r.reason.clone(),
            event: r.event.clone(),
            fired_at: r.fired_at.clone(),
            status: r.status.clone(),
            error: r.error.clone(),
            stop_reason: r.stop_reason.clone(),
        }
    }
}

fn now_rfc3339() -> String {
    Local::now().to_rfc3339()
}

/// Replaces the engine's whole config in one shot — same "always restart
/// rather than diff old vs. new" rule `crate::mcp::apply`/`crate::acp::
/// acp_start` already follow, since there's no cheap way to tell what
/// changed. Called by `lib/automationsEngine.ts`'s `syncAutomationsEngine`
/// after every skill/automation edit and whenever the open workspace (or
/// configured agent command) changes.
#[tauri::command(rename_all = "camelCase")]
pub async fn automations_sync(engine: State<'_, AutomationEngine>, cwd: String, automations: Vec<AutomationSyncDto>) -> Result<(), String> {
    let mut data = engine.data.lock().await;
    data.cwd = Some(cwd);
    data.automations = automations;
    Ok(())
}

/// Fires `automation_id` immediately — the Automations tab's "Run now".
/// `simulate_event` stands in for a real row change on a data-triggered
/// automation. Resolves once the run has actually finished
/// and been persisted — a caller doesn't get the agent's failure as a
/// command error, since a failed run is still a real run worth showing in
/// the list (see `RunRecord::status`), not something to discard.
#[tauri::command(rename_all = "camelCase")]
pub async fn automation_run_now(app: AppHandle, engine: State<'_, AutomationEngine>, automation_id: String, simulate_event: Option<String>) -> Result<(), String> {
    let (automation, cwd) = {
        let data = engine.data.lock().await;
        let automation = data
            .automations
            .iter()
            .find(|a| a.id == automation_id)
            .cloned()
            .ok_or_else(|| "this trigger isn't enabled or configured — enable it and set a cron/data condition first".to_string())?;
        let cwd = data.cwd.clone().ok_or_else(|| "no workspace open".to_string())?;
        (automation, cwd)
    };

    let event = simulate_event.and_then(|kind| {
        automation.data.as_ref().map(|d| AutomationEventDto {
            database: d.database_id.clone(),
            table: d.table.clone(),
            event: kind,
            params: None,
            fired_at: now_rfc3339(),
        })
    });

    fire_automation(app, cwd, automation, "manual".to_string(), event).await;
    Ok(())
}

/// `automation_id`'s fire history, most recent first — what
/// `AutomationRunsView.tsx` renders ("the ACP chats initiated by the
/// trigger"). Empty (not an error) if the automation has never fired, or
/// no runs directory exists yet. A malformed/unreadable run file is
/// skipped with a log line rather than failing the whole list — same "one
/// bad record must never brick the view" spirit `sqldb::apply_event`
/// already follows for the ledger.
#[tauri::command(rename_all = "camelCase")]
pub async fn automation_runs_list(app: AppHandle, automation_id: String) -> Result<Vec<AutomationRunSummaryDto>, String> {
    let dir = runs_dir(&app, &automation_id)?;
    let mut read_dir = match fs::read_dir(&dir).await {
        Ok(rd) => rd,
        Err(_) => return Ok(Vec::new()),
    };

    let mut summaries = Vec::new();
    loop {
        let entry = match read_dir.next_entry().await {
            Ok(Some(e)) => e,
            Ok(None) => break,
            Err(e) => {
                eprintln!("[automation] failed to read {dir:?}: {e}");
                break;
            }
        };
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match fs::read(&path).await {
            Ok(bytes) => match serde_json::from_slice::<RunRecord>(&bytes) {
                Ok(record) => summaries.push(AutomationRunSummaryDto::from(&record)),
                Err(e) => eprintln!("[automation] malformed run file {path:?}, skipping: {e}"),
            },
            Err(e) => eprintln!("[automation] failed to read run file {path:?}, skipping: {e}"),
        }
    }
    summaries.sort_by(|a, b| b.fired_at.cmp(&a.fired_at));
    Ok(summaries)
}

/// One run's full transcript — `AutomationRunChat.tsx`'s data source.
#[tauri::command(rename_all = "camelCase")]
pub async fn automation_run_get(app: AppHandle, automation_id: String, run_id: String) -> Result<RunRecord, String> {
    let path = run_path(&app, &automation_id, &run_id)?;
    let bytes = fs::read(&path).await.map_err(|e| format!("run not found: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

fn runs_dir(app: &AppHandle, automation_id: &str) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("automation-runs").join(automation_id))
}

fn run_path(app: &AppHandle, automation_id: &str, run_id: &str) -> Result<PathBuf, String> {
    Ok(runs_dir(app, automation_id)?.join(format!("{run_id}.json")))
}

async fn persist_run(app: &AppHandle, record: &RunRecord) -> Result<(), String> {
    let dir = runs_dir(app, &record.automation_id)?;
    fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", record.id));
    let bytes = serde_json::to_vec_pretty(record).map_err(|e| e.to_string())?;
    fs::write(&path, bytes).await.map_err(|e| e.to_string())
}

/// The skill's instructions, plus the triggering event as pretty JSON for
/// a data-triggered fire.
fn build_prompt(automation: &AutomationSyncDto, event: Option<&AutomationEventDto>) -> String {
    match event {
        Some(ev) => {
            let json = serde_json::to_string_pretty(ev).unwrap_or_default();
            format!("{}\n\n{json}", automation.skill_instructions)
        }
        None => automation.skill_instructions.clone(),
    }
}

/// Spawns the configured agent, sends `prompt` as one turn, and collects
/// every `session/update` payload streamed back while it runs. Unlike
/// `crate::acp::acp_start`, there's no long-lived session to keep around
/// afterward and no window to forward events to live — the whole point of
/// an unattended fire is that nothing has to be watching.
///
/// A `session/request_permission` the agent sends mid-turn is left
/// unanswered: there's no UI to ask, and auto-approving would silently
/// grant whatever the agent asked for. It just sits until `FIRE_TIMEOUT`
/// cuts the turn off — an automation whose skill needs permission prompts
/// answered isn't a good fit for unattended firing yet; that's a
/// documented limitation, not a bug.
async fn run_agent(automation: &AutomationSyncDto, cwd: &str, prompt: &str) -> Result<(Vec<JsonValue>, Option<String>), (String, Vec<JsonValue>)> {
    if automation.agent_command.trim().is_empty() {
        return Err(("no agent command configured — set one in Settings".to_string(), Vec::new()));
    }

    let (client, mut events) =
        AcpClient::spawn(&automation.agent_command, &automation.agent_args, cwd).await.map_err(|e| (e.to_string(), Vec::new()))?;

    let session_id = match client.new_session(cwd, Vec::new()).await {
        Ok(id) => id,
        Err(e) => {
            client.shutdown().await;
            return Err((e.to_string(), Vec::new()));
        }
    };

    let updates: Arc<Mutex<Vec<JsonValue>>> = Arc::new(Mutex::new(Vec::new()));
    let updates_for_drain = updates.clone();
    let drain = tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            if let AcpEvent::Update(payload) = event {
                updates_for_drain.lock().await.push(payload);
            }
        }
    });

    let prompt_result = tokio::time::timeout(FIRE_TIMEOUT, client.prompt(&session_id, prompt)).await;
    client.shutdown().await;
    let _ = drain.await;

    let collected = Arc::try_unwrap(updates).map(|m| m.into_inner()).unwrap_or_default();

    match prompt_result {
        Ok(Ok(result)) => {
            let stop_reason = result.get("stopReason").and_then(|v| v.as_str()).map(str::to_string);
            Ok((collected, stop_reason))
        }
        Ok(Err(e)) => Err((e.to_string(), collected)),
        Err(_) => Err(("timed out waiting for the agent's turn to end".to_string(), collected)),
    }
}

/// Runs `automation` end to end — spawn, prompt, collect, persist, notify
/// — and never propagates a failure: an agent error/timeout becomes an
/// `"error"` `RunRecord` rather than a dropped fire, so it still shows up
/// for the user to see why. Only an I/O failure persisting the record
/// itself is swallowed with a log line (nowhere left to report it).
async fn fire_automation(app: AppHandle, cwd: String, automation: AutomationSyncDto, reason: String, event: Option<AutomationEventDto>) {
    let run_id = uuid::Uuid::new_v4().to_string();
    let fired_at = now_rfc3339();
    let prompt = build_prompt(&automation, event.as_ref());
    eprintln!("[automation] firing {:?} ({reason}, skill {:?}) -> run {run_id}", automation.name, automation.skill_name);

    let (status, error, stop_reason, updates) = match run_agent(&automation, &cwd, &prompt).await {
        Ok((updates, stop_reason)) => ("done".to_string(), None, stop_reason, updates),
        Err((message, updates)) => ("error".to_string(), Some(message), None, updates),
    };

    let record = RunRecord {
        id: run_id.clone(),
        automation_id: automation.id.clone(),
        automation_name: automation.name.clone(),
        reason,
        event,
        fired_at,
        status,
        error,
        stop_reason,
        prompt,
        updates,
    };

    if let Err(e) = persist_run(&app, &record).await {
        eprintln!("[automation] failed to persist run {} for {}: {e}", record.id, record.automation_id);
    }

    if let Err(e) = app.emit(RUN_EVENT, serde_json::json!({ "automationId": automation.id, "runId": run_id })) {
        eprintln!("[automation] failed to emit {RUN_EVENT}: {e}");
    }
}

/// Matches every automation with a `data` watch on `(database_id, table)`
/// against `event`, and fires each one — called from `commands::db_exec`
/// right after a successful non-batch write. Fire-and-forget: each match
/// is spawned as its own task rather than awaited here, so a slow/hanging
/// agent never delays the `db_exec` command's own response to the caller
/// that made the edit.
pub async fn fire_data_triggers(app: AppHandle, engine: &AutomationEngine, database_id: &str, table: &str, event: &str, params: Vec<JsonValue>) {
    let (matches, cwd) = {
        let data = engine.data.lock().await;
        let Some(cwd) = data.cwd.clone() else { return };
        let matches: Vec<AutomationSyncDto> = data
            .automations
            .iter()
            .filter(|a| {
                a.data
                    .as_ref()
                    .map(|d| d.database_id == database_id && d.table == table && d.events.iter().any(|e| e == event))
                    .unwrap_or(false)
            })
            .cloned()
            .collect();
        (matches, cwd)
    };

    for automation in matches {
        let event_dto = AutomationEventDto {
            database: database_id.to_string(),
            table: table.to_string(),
            event: event.to_string(),
            params: if params.is_empty() { None } else { Some(params.clone()) },
            fired_at: now_rfc3339(),
        };
        let app = app.clone();
        let cwd = cwd.clone();
        tauri::async_runtime::spawn(async move {
            fire_automation(app, cwd, automation, "data".to_string(), Some(event_dto)).await;
        });
    }
}

/// Best-effort classification of a `db_exec` statement as an insert/
/// update/delete against a specific table — only recognizes the exact
/// shapes dendroid's own basic table UI generates
/// (`components/database/DatabaseView.tsx`: `INSERT INTO "t" ...`,
/// `UPDATE "t" SET ...`, `DELETE FROM "t" ...`), not arbitrary SQL typed
/// into the "Run SQL" console. `commands::db_exec` only calls this for
/// non-batch statements to begin with; a single statement that isn't one
/// of these three shapes (or a `CREATE TABLE`, `PRAGMA`, ...) just matches
/// nothing here, the same "silently does nothing rather than misfiring"
/// choice `sqldb::apply_event` makes for a record it doesn't recognize.
pub fn detect_write(sql: &str) -> Option<(String, String)> {
    let trimmed = sql.trim();
    let prefix: String = trimmed.chars().take(11).collect::<String>().to_ascii_uppercase();
    let (event, skip): (&str, usize) = if prefix.starts_with("INSERT INTO") {
        ("insert", 11)
    } else if prefix.starts_with("DELETE FROM") {
        ("delete", 11)
    } else if prefix.starts_with("UPDATE") {
        ("update", 6)
    } else {
        return None;
    };
    let table = parse_ident(trimmed.get(skip..)?)?;
    Some((event.to_string(), table))
}

/// Reads one SQL identifier off the front of `rest` — either
/// double-quoted (`quote_ident`'s own output, what every call site in
/// `sqldb`/`DatabaseView.tsx` actually produces) or a bare word, for a
/// hand-typed statement that skipped quoting. Best-effort, same as
/// `detect_write` itself: doesn't handle `""`-escaped quotes inside a
/// quoted identifier, since nothing dendroid generates needs that.
fn parse_ident(rest: &str) -> Option<String> {
    let rest = rest.trim_start();
    if let Some(stripped) = rest.strip_prefix('"') {
        let end = stripped.find('"')?;
        Some(stripped[..end].to_string())
    } else {
        let end = rest.find(|c: char| c.is_whitespace()).unwrap_or(rest.len());
        if end == 0 {
            None
        } else {
            Some(rest[..end].to_string())
        }
    }
}

/// Matches a 5-field cron expression against `now` — minute, hour,
/// day-of-month, month, day-of-week (0 = Sunday), the same field order
/// `lib/automations.ts`'s `cronScheduleToExpression` emits. Evaluated
/// against local time, not UTC: a "daily at 9am" schedule set through the
/// friendly cron form should mean this device's 9am.
fn cron_matches(expr: &str, now: &DateTime<Local>) -> bool {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return false;
    }
    field_matches(fields[0], now.minute() as i64)
        && field_matches(fields[1], now.hour() as i64)
        && field_matches(fields[2], now.day() as i64)
        && field_matches(fields[3], now.month() as i64)
        && field_matches(fields[4], now.weekday().num_days_from_sunday() as i64)
}

/// Matches one cron field against `value` — `*`, a bare integer, a
/// comma-separated list of either, or a `*/N` step. Covers everything
/// `cronScheduleToExpression` ever generates (only ever `*` or a bare
/// integer) plus enough extra syntax that a hand-edited expression
/// wouldn't need a richer matcher.
fn field_matches(field: &str, value: i64) -> bool {
    field.split(',').any(|part| {
        if part == "*" {
            return true;
        }
        if let Some(step) = part.strip_prefix("*/") {
            return step.parse::<i64>().map(|s| s > 0 && value % s == 0).unwrap_or(false);
        }
        part.parse::<i64>().map(|n| n == value).unwrap_or(false)
    })
}

/// Ticks every `CRON_TICK`, fires whatever automation's cron matches the
/// current minute (and hasn't already fired it this minute — see
/// `EngineData::last_fired_minute`), and spawns each fire independently so
/// one slow agent never delays another automation's own on-time fire.
/// Started once from `lib.rs`'s `.setup()`, for the process's whole
/// lifetime — there's no "stop" (nothing currently tears the app down
/// short of quitting).
pub fn spawn_cron_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(CRON_TICK).await;

            let engine = app.state::<AutomationEngine>();
            let now = Local::now();
            let minute_ts = now.timestamp().div_euclid(60);

            let due: Vec<(AutomationSyncDto, String)> = {
                let mut data = engine.data.lock().await;
                let Some(cwd) = data.cwd.clone() else { continue };

                let mut due = Vec::new();
                let automations = data.automations.clone();
                for automation in automations {
                    let Some(expr) = automation.cron.clone() else { continue };
                    if !cron_matches(&expr, &now) {
                        continue;
                    }
                    if data.last_fired_minute.get(&automation.id).copied() == Some(minute_ts) {
                        continue;
                    }
                    data.last_fired_minute.insert(automation.id.clone(), minute_ts);
                    due.push((automation, cwd.clone()));
                }
                due
            };

            for (automation, cwd) in due {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    fire_automation(app, cwd, automation, "cron".to_string(), None).await;
                });
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, mo, d, h, mi, 0).single().expect("valid local time")
    }

    #[test]
    fn cron_matches_exact_daily_time() {
        let now = at(2026, 8, 15, 9, 0);
        assert!(cron_matches("0 9 * * *", &now));
        assert!(!cron_matches("0 9 * * *", &at(2026, 8, 15, 9, 1)));
        assert!(!cron_matches("30 9 * * *", &now));
    }

    #[test]
    fn cron_matches_weekly_on_day_of_week() {
        let day = at(2026, 8, 15, 9, 0);
        let dow = day.weekday().num_days_from_sunday();
        assert!(cron_matches(&format!("0 9 * * {dow}"), &day));
        assert!(!cron_matches(&format!("0 9 * * {}", (dow + 1) % 7), &day));
    }

    #[test]
    fn cron_matches_hourly_ignores_hour_field() {
        assert!(cron_matches("15 * * * *", &at(2026, 8, 15, 3, 15)));
        assert!(cron_matches("15 * * * *", &at(2026, 8, 15, 23, 15)));
        assert!(!cron_matches("15 * * * *", &at(2026, 8, 15, 3, 16)));
    }

    #[test]
    fn cron_matches_rejects_malformed_expressions() {
        assert!(!cron_matches("not a cron", &at(2026, 8, 15, 9, 0)));
        assert!(!cron_matches("0 9 * *", &at(2026, 8, 15, 9, 0)));
    }

    #[test]
    fn field_matches_supports_lists_and_steps() {
        assert!(field_matches("*", 42));
        assert!(field_matches("5", 5));
        assert!(!field_matches("5", 6));
        assert!(field_matches("1,5,9", 5));
        assert!(field_matches("*/15", 30));
        assert!(!field_matches("*/15", 31));
    }

    #[test]
    fn detect_write_recognizes_the_table_uis_own_statement_shapes() {
        assert_eq!(detect_write(r#"INSERT INTO "tasks" DEFAULT VALUES"#), Some(("insert".to_string(), "tasks".to_string())));
        assert_eq!(detect_write(r#"UPDATE "tasks" SET "done" = ?1 WHERE rowid = ?2"#), Some(("update".to_string(), "tasks".to_string())));
        assert_eq!(detect_write(r#"DELETE FROM "tasks" WHERE rowid = ?1"#), Some(("delete".to_string(), "tasks".to_string())));
        assert_eq!(detect_write("update tasks set done = 1"), Some(("update".to_string(), "tasks".to_string())));
    }

    #[test]
    fn detect_write_ignores_reads_and_schema_changes() {
        assert_eq!(detect_write("SELECT * FROM tasks"), None);
        assert_eq!(detect_write(r#"CREATE TABLE "tasks" (id INTEGER)"#), None);
    }
}
