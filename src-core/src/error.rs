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
}

pub type Result<T> = std::result::Result<T, DendroidError>;
