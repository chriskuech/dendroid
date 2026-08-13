//! Platform-agnostic core: the document CRDT, the append-only ledger it's
//! persisted through, and the glue (`doc`) a host embeds.
//!
//! There's no separate structural tree CRDT. The document *is* a single
//! Loro container shaped like a ProseMirror doc — the same one TipTap's
//! `loro-prosemirror` binding edits directly — and the heading tree
//! (`outline`) is derived from it on read, the same way a table of
//! contents is built from markdown (see `outline` for why).
//!
//! ```text
//! TipTap (ProseMirror)  <-loro-prosemirror->  LoroDoc (frontend mirror)
//!                                                   | doc.subscribeLocalUpdates / "crdt://update" event
//!                                                   v
//!                                        DendroidDocument (this crate)
//!                                                   | append (own session's file)
//!                                                   v
//!                          {workspace_root}/ledger/{yyyy-mm-dd}.{session_id}.log
//!                                                   ^
//!                                                   | poll_external (other sessions/replicas)
//! ```

pub mod doc;
pub mod error;
pub mod history;
pub mod ledger;
pub mod links;
mod loro_walk;
pub mod markdown;
#[cfg(not(target_arch = "wasm32"))]
pub mod native;
mod migrate;
pub mod outline;
#[cfg(not(target_arch = "wasm32"))]
pub mod sqldb;
pub mod storage;

pub use doc::DendroidDocument;
pub use error::{DendroidError, Result};
pub use history::HistoryEntryDto;
pub use ledger::new_session_id;
pub use links::{LinkEntryDto, LinkRefDto};
pub use markdown::ApplyMode;
pub use outline::{HeadingDto, OutlineEntry};
#[cfg(not(target_arch = "wasm32"))]
pub use sqldb::{ColumnDto, DatabaseDto, DbHistoryEntryDto, QueryResultDto, SqlWorkspace, TableDto, TableRowDto, TableRowsDto};
pub use storage::LedgerStorage;
