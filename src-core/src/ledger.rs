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
//!
//! `LedgerWriter`/`LedgerCursor` are generic over the payload (`P`) each
//! line carries, defaulting to `LoroUpdate` so every existing call site
//! (and every byte already on disk) is untouched. `crate::sqldb` reuses the
//! exact same append/tail machinery for its own `DbEvent` payload, pointed
//! at a different subdirectory (see `native::NativeLedgerStorage::
//! for_databases`) — same per-(day,session)-file convention, same
//! multi-writer story, just a different envelope and a different `P`.

use std::collections::HashMap;
use std::marker::PhantomData;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::crypto::EncryptionKey;
use crate::error::{DendroidError, Result};
use crate::storage::LedgerStorage;

/// The payload every existing (and, going forward, every ordinary
/// markdown-tree) ledger line carries — a base64-encoded Loro update blob,
/// optionally encrypted (see `enc`). Named and shaped so `#[serde(flatten)]`
/// -ing it into `Envelope` produces byte-identical JSON to the hand-written
/// struct this replaced for a plaintext record (just an `update` key
/// alongside `seq`/`ts`/`session_id`), so every ledger file ever written
/// before encryption existed stays readable with zero migration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoroUpdate {
    update: String,
    /// The encrypting key's fingerprint, present only when `update` is
    /// ciphertext (`crypto::EncryptionKey::encrypt` output) rather than a
    /// raw Loro update blob — see `new_encrypted`/`decode`. Carried mainly
    /// so a human staring at raw ledger JSON can tell an encrypted line
    /// apart from a plaintext one; `decode` doesn't actually need it to
    /// match anything (a wrong key just fails the AEAD's own check).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    enc: Option<String>,
}

impl LoroUpdate {
    pub fn new(bytes: &[u8]) -> Self {
        Self { update: STANDARD.encode(bytes), enc: None }
    }

    /// Same as `new`, but encrypts `bytes` with `key` first — what every
    /// append becomes once a device has an encryption key set (see
    /// `doc::DendroidDocument::append_delta`), and what re-encrypting
    /// already-plaintext history produces (`rewrite_payloads`, driven by
    /// `doc::DendroidDocument::set_key`).
    pub fn new_encrypted(bytes: &[u8], key: &EncryptionKey) -> Self {
        Self { update: STANDARD.encode(key.encrypt(bytes)), enc: Some(key.fingerprint()) }
    }

    /// Whether this record is ciphertext rather than a raw Loro update —
    /// `rewrite_payloads`' re-encryption transform uses this to leave an
    /// already-encrypted record untouched.
    pub fn is_encrypted(&self) -> bool {
        self.enc.is_some()
    }

    /// Decodes this record back into raw Loro update bytes. `key` is only
    /// consulted when the record is actually encrypted (`enc.is_some()`);
    /// a plaintext record decodes the same regardless of whether this
    /// device has encryption enabled — see `doc::DendroidDocument::
    /// import_records` for how a `None`/wrong key on an encrypted record
    /// surfaces as a blocked-sync state rather than a dropped record.
    pub fn decode(&self, key: Option<&EncryptionKey>) -> Result<Vec<u8>> {
        let raw = STANDARD.decode(&self.update).map_err(|e| DendroidError::LedgerRecord {
            location: "<in-memory>".to_string(),
            line: 0,
            reason: format!("bad base64 payload: {e}"),
        })?;
        match &self.enc {
            None => Ok(raw),
            Some(_) => key.ok_or(DendroidError::EncryptionRequired)?.decrypt(&raw),
        }
    }
}

/// One line of a ledger file: metadata common to every kind of logged
/// event, plus whatever `P` is logging.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Envelope<P> {
    seq: u64,
    ts: String,
    session_id: String,
    #[serde(flatten)]
    payload: P,
}

/// A payload as handed back by `LedgerCursor::poll`, together with the
/// envelope metadata a payload type might need (e.g. `crate::sqldb`'s
/// `DbEvent::Exec` wants a real timestamp for its history view — SQLite has
/// no oplog of its own to derive one from the way Loro does).
#[derive(Debug, Clone)]
pub struct PolledRecord<P> {
    pub ts: String,
    pub session_id: String,
    pub payload: P,
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

/// Appends this session's records to today's ledger file (through `S`),
/// rolling over to a new file automatically when the date changes under a
/// long-running process. Generic over the payload `P` each line carries —
/// see the module doc comment.
pub struct LedgerWriter<S: LedgerStorage, P = LoroUpdate> {
    storage: S,
    session_id: String,
    date: String,
    seq: u64,
    _payload: PhantomData<P>,
}

impl<S: LedgerStorage, P: Serialize> LedgerWriter<S, P> {
    pub async fn open(storage: S, session_id: impl Into<String>) -> Result<Self> {
        let session_id = session_id.into();
        let date = today();
        let seq = count_lines(&storage.read_from(&record_name(&date, &session_id), 0).await?);
        Ok(Self { storage, session_id, date, seq, _payload: PhantomData })
    }

    /// This session's current ledger file name (rolls over at midnight).
    pub fn name(&self) -> String {
        record_name(&self.date, &self.session_id)
    }

    /// The storage backend this writer (and its owning `DendroidDocument`/
    /// `SqlWorkspace`) is writing into — a cursor needs the same one to
    /// tail for other sessions'/replicas' writes.
    pub fn storage(&self) -> &S {
        &self.storage
    }

    /// Append one record as a single JSON line.
    pub async fn append(&mut self, payload: P) -> Result<()> {
        let today = today();
        if today != self.date {
            self.date = today;
            self.seq = count_lines(&self.storage.read_from(&self.name(), 0).await?);
        }

        let record = Envelope { seq: self.seq, ts: Utc::now().to_rfc3339(), session_id: self.session_id.clone(), payload };
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
/// and this cursor is how we notice. Generic over the payload `P` — see
/// the module doc comment.
pub struct LedgerCursor<P = LoroUpdate> {
    offsets: HashMap<String, u64>,
    _payload: PhantomData<P>,
}

impl<P> Default for LedgerCursor<P> {
    fn default() -> Self {
        Self { offsets: HashMap::new(), _payload: PhantomData }
    }
}

impl<P: DeserializeOwned> LedgerCursor<P> {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns newly-available records (in file-then-line order) since the
    /// last call. Malformed lines (e.g. a torn write from a crash
    /// mid-append, or a line belonging to a different payload shape than
    /// `P`) are skipped with a logged warning rather than failing the
    /// whole poll — one bad record must never brick the workspace.
    pub async fn poll<S: LedgerStorage>(&mut self, storage: &S) -> Result<Vec<PolledRecord<P>>> {
        let mut records = Vec::new();

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
                match serde_json::from_slice::<Envelope<P>>(line) {
                    Ok(record) => records.push(PolledRecord { ts: record.ts, session_id: record.session_id, payload: record.payload }),
                    Err(e) => eprintln!("[ledger] {name}:{i}: malformed record, skipping: {e}"),
                }
            }

            self.offsets.insert(name, start + complete.len() as u64);
        }

        Ok(records)
    }
}

/// Rewrites every existing ledger file's payloads through `transform`,
/// preserving each record's own `seq`/`ts`/`session_id` — the one place
/// this module breaks its own "never mutated in place" rule (see
/// `LedgerStorage::write`). Used exactly once: `doc::DendroidDocument`
/// turning encryption on for the first time re-encrypts every
/// already-written plaintext record with the newly created/paired key
/// (`transform` there leaves any already-encrypted record untouched).
///
/// A malformed line here is a hard error rather than the usual
/// skip-and-warn (`LedgerCursor::poll`'s behavior) — this rewrite isn't an
/// incremental tail that can afford to lose a line silently; if something
/// can't be read back, better to fail the whole rewrite (leaving every
/// file as it was, since nothing's written until each file's own rewrite
/// completes) than to quietly drop a record while re-encrypting history.
pub async fn rewrite_payloads<S, P, F>(storage: &S, mut transform: F) -> Result<()>
where
    S: LedgerStorage,
    P: Serialize + DeserializeOwned,
    F: FnMut(P) -> Result<P>,
{
    for name in storage.list_files().await? {
        let bytes = storage.read_from(&name, 0).await?;
        if bytes.is_empty() {
            continue;
        }

        let mut out = Vec::with_capacity(bytes.len());
        for (i, line) in bytes.split(|&b| b == b'\n').enumerate() {
            if line.is_empty() {
                continue;
            }
            let env: Envelope<P> = serde_json::from_slice(line)
                .map_err(|e| DendroidError::LedgerRecord { location: name.clone(), line: i, reason: e.to_string() })?;
            let payload = transform(env.payload)?;
            let rewritten = Envelope { seq: env.seq, ts: env.ts, session_id: env.session_id, payload };
            let line_json = serde_json::to_string(&rewritten)
                .map_err(|e| DendroidError::LedgerRecord { location: name.clone(), line: i, reason: e.to_string() })?;
            out.extend_from_slice(line_json.as_bytes());
            out.push(b'\n');
        }

        storage.write(&name, &out).await?;
    }
    Ok(())
}
