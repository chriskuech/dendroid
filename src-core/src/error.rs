use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum DendroidError {
    #[error("crdt error: {0}")]
    Crdt(#[from] loro::LoroError),

    #[error("crdt export failed: {0}")]
    CrdtExport(#[from] loro::LoroEncodeError),

    #[error("io error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// A `LedgerStorage` failure that isn't a `std::io::Error` — e.g. a JS
    /// exception from the File System Access API, which doesn't implement
    /// `std::error::Error`. `NativeLedgerStorage` uses `Io` instead, since
    /// it has a real one.
    #[error("ledger storage error at {location}: {reason}")]
    Storage { location: String, reason: String },

    #[error("malformed ledger record in {location} (line {line}): {reason}")]
    LedgerRecord {
        location: String,
        line: usize,
        reason: String,
    },

    #[error("tree node {0} not found")]
    NodeNotFound(String),

    #[error("invalid tree id {0:?}: {1}")]
    InvalidTreeId(String, String),

    #[error("history error: {0}")]
    History(String),

    #[error("database {0:?} not found")]
    DbNotFound(String),

    #[error("table {0:?} not found")]
    TableNotFound(String),

    #[error("sql error: {0}")]
    Sql(String),

    /// A ledger record is encrypted, but this device has no encryption key
    /// set. Distinct from `WrongEncryptionKey` only so `crypto::
    /// EncryptionKey::decode`'s callers *could* tell the two apart if they
    /// ever needed to — today `doc::DendroidDocument` treats both the same
    /// way (sets `blocked_reason`, stops syncing).
    #[error("this event is encrypted; enable encryption to read it")]
    EncryptionRequired,

    /// A ledger record is encrypted, and this device has *a* key, but it's
    /// not the one this record was encrypted with (or the record is
    /// corrupted) — see `crypto::EncryptionKey::decrypt`.
    #[error("could not decrypt this event — the wrong encryption key is set")]
    WrongEncryptionKey,

    /// A key someone typed, pasted, or scanned doesn't parse as one — see
    /// `crypto::EncryptionKey::from_text`.
    #[error("invalid encryption key: {0}")]
    InvalidEncryptionKey(String),
}

pub type Result<T> = std::result::Result<T, DendroidError>;
