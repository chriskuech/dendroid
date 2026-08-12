//! The transaction log. Every mutation to the document is a Loro update
//! (a byte blob from `LoroDoc::export(ExportMode::updates(..))`), appended
//! as one JSON line to a per-(day, session) ledger file — see
//! `LedgerStorage` for where those files actually live (real files
//! natively, the browser's Origin Private File System on web).
//!
//! One file per (day, session): each running app instance owns exactly one
//! file at a time, so appends never need cross-writer locking. The
//! session id in the filename is what makes this safe on a synced folder
//! (iCloud Drive, Dropbox, etc.) — two replicas of the same workspace never
//! write the same path, so there's nothing for the sync engine to conflict
//! on; ledger state is rebuilt by importing every file's updates into Loro,
//! which merges them as a CRDT regardless of file or line order.
//!
//! State is *never* mutated in place here — only appended. The current
//! document is always just "replay every ledger file into a fresh LoroDoc".

use std::collections::HashMap;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::error::{DendroidError, Result};
use crate::storage::LedgerStorage;

/// One line of a ledger file.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LedgerRecord {
    seq: u64,
    ts: String,
    session_id: String,
    /// Base64-encoded Loro update bytes.
    update: String,
}

/// A fresh id for this running app instance. Embedded in every ledger
/// filename it writes, and in every record it appends.
pub fn new_session_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn today() -> String {
    Utc::now().format("%Y-%m-%d").to_string()
}

fn record_name(date: &str, session_id: &str) -> String {
    format!("{date}.{session_id}.log")
}

/// Number of well-formed lines already recorded, used to resume `seq`
/// correctly when re-opening the same session's file later the same day
/// (e.g. after the app restarts).
fn count_lines(bytes: &[u8]) -> u64 {
    bytes.split(|&b| b == b'\n').filter(|line| !line.is_empty()).count() as u64
}

/// Appends this session's updates to today's ledger file (through `S`),
/// rolling over to a new file automatically when the date changes under a
/// long-running process.
pub struct LedgerWriter<S: LedgerStorage> {
    storage: S,
    session_id: String,
    date: String,
    seq: u64,
}

impl<S: LedgerStorage> LedgerWriter<S> {
    pub async fn open(storage: S, session_id: impl Into<String>) -> Result<Self> {
        let session_id = session_id.into();
        let date = today();
        let seq = count_lines(&storage.read_from(&record_name(&date, &session_id), 0).await?);
        Ok(Self { storage, session_id, date, seq })
    }

    /// This session's current ledger file name (rolls over at midnight).
    pub fn name(&self) -> String {
        record_name(&self.date, &self.session_id)
    }

    /// The storage backend this writer (and its owning `DendroidDocument`)
    /// is writing into — `LedgerCursor::poll` needs the same one to tail
    /// for other sessions'/replicas' writes.
    pub fn storage(&self) -> &S {
        &self.storage
    }

    /// Append one update blob as a single JSON line.
    pub async fn append(&mut self, update: &[u8]) -> Result<()> {
        if update.is_empty() {
            return Ok(());
        }

        let today = today();
        if today != self.date {
            self.date = today;
            self.seq = count_lines(&self.storage.read_from(&self.name(), 0).await?);
        }

        let record = LedgerRecord {
            seq: self.seq,
            ts: Utc::now().to_rfc3339(),
            session_id: self.session_id.clone(),
            update: STANDARD.encode(update),
        };
        let name = self.name();
        let line = serde_json::to_string(&record)
            .map_err(|e| DendroidError::LedgerRecord { location: name.clone(), line: self.seq as usize, reason: e.to_string() })?;

        self.storage.append(&name, format!("{line}\n").as_bytes()).await?;
        self.seq += 1;
        Ok(())
    }
}

/// Incrementally tails every ledger file, remembering a byte offset per
/// file so repeated polls only decode newly appended lines. Used both for
/// the initial full replay (starting from offset 0 on every file) and for
/// ongoing multi-writer merge — other sessions of this app, or another
/// replica of the workspace folder entirely, each write their own file,
/// and this cursor is how we notice.
#[derive(Default)]
pub struct LedgerCursor {
    offsets: HashMap<String, u64>,
}

impl LedgerCursor {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns newly-available update blobs (decoded, in file-then-line
    /// order) since the last call. Malformed lines (e.g. a torn write from
    /// a crash mid-append) are skipped with a logged warning rather than
    /// failing the whole poll — one bad record must never brick the
    /// document.
    pub async fn poll<S: LedgerStorage>(&mut self, storage: &S) -> Result<Vec<Vec<u8>>> {
        let mut updates = Vec::new();

        let mut names = storage.list_files().await?;
        names.sort();

        for name in names {
            let len = storage.len(&name).await?;
            let start = self.offsets.get(&name).copied().unwrap_or(0);
            if len <= start {
                continue;
            }

            let buf = storage.read_from(&name, start).await?;

            // Only consume complete lines; a writer could be mid-flush on
            // the tail line right now. Leave any trailing partial bytes
            // for the next poll.
            let Some(last_newline) = buf.iter().rposition(|&b| b == b'\n') else {
                continue;
            };
            let complete = &buf[..=last_newline];

            for (i, line) in complete.split(|&b| b == b'\n').enumerate() {
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_slice::<LedgerRecord>(line) {
                    Ok(record) => match STANDARD.decode(&record.update) {
                        Ok(bytes) => updates.push(bytes),
                        Err(e) => eprintln!("[ledger] {name}:{i}: bad base64 payload: {e}"),
                    },
                    Err(e) => eprintln!("[ledger] {name}:{i}: malformed record, skipping: {e}"),
                }
            }

            self.offsets.insert(name, start + complete.len() as u64);
        }

        Ok(updates)
    }
}
