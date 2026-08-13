//! The document's change history, derived straight from Loro's own oplog —
//! the same `Change`s the ledger persists (`crate::ledger`), just read back
//! out through Loro's API instead of parsed off disk. What lets a host offer
//! "view history / roll back to a point": `history` lists every point,
//! `revert_to` jumps the live document back to one of them.
//!
//! Rolling back is deliberately *not* `LoroDoc::checkout` (which detaches
//! the doc into a read-only view of the past) — it's `LoroDoc::revert_to`,
//! which computes the diff between now and the target and applies it as
//! ordinary new operations. That keeps the document attached and editable,
//! and — critically for a CRDT synced across replicas/ledger files — means
//! a rollback is just another change for every replica to merge and
//! converge on, not a rewrite of history any replica could disagree about.

use std::ops::ControlFlow;

use loro::{ChangeMeta, Frontiers, LoroDoc, ID};
use serde::{Deserialize, Serialize};

use crate::error::{DendroidError, Result};

/// The commit message `revert_to` tags its own rollback commit with, so a
/// later `history()` call (and the panel it feeds) can tell "this entry
/// *is* a rollback" apart from an ordinary edit.
pub const REVERT_COMMIT_MESSAGE: &str = "Rollback";

/// One point in the document's history — what a history panel lists. See
/// the module doc comment for why "point" means a `Change`, not a single
/// keystroke (Loro already merges nearby same-peer edits into one, by
/// default anything within 1000s — see `LoroDoc::set_change_merge_interval`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntryDto {
    /// Opaque token identifying this point — round-trips through
    /// `revert_to`. Never inspect its contents; the encoding is an
    /// implementation detail of this module.
    pub token: String,
    /// Unix seconds this change was committed, or `0` if it predates
    /// `LoroDoc::set_record_timestamp` being turned on (a ledger written
    /// before this feature existed) — callers should treat `0` as unknown
    /// rather than as the epoch.
    pub timestamp: i64,
    /// The change's own commit message, if one was set — e.g.
    /// `REVERT_COMMIT_MESSAGE` for a rollback's own commit. Empty for an
    /// ordinary edit (nothing sets one today).
    pub message: String,
    /// How many ops this change groups together — a rough size hint, not
    /// something worth showing verbatim (an "edit" either way).
    pub len: usize,
}

/// Encodes `frontiers` (however many concurrent ids it holds) as an opaque
/// round-trippable string. `PeerID` is `u64`, which doesn't fit losslessly
/// in an `f64` — stringified here so the JSON payload round-trips exactly
/// across the IPC/wasm boundary rather than silently losing precision the
/// way a bare number would.
fn encode_token(frontiers: &Frontiers) -> String {
    let ids: Vec<(String, i32)> = frontiers.iter().map(|id| (id.peer.to_string(), id.counter)).collect();
    // A handful of u64/i32 pairs can't fail to serialize.
    serde_json::to_string(&ids).expect("frontiers token is always serializable")
}

fn decode_token(token: &str) -> Result<Frontiers> {
    let pairs: Vec<(String, i32)> =
        serde_json::from_str(token).map_err(|e| DendroidError::History(format!("invalid history token: {e}")))?;
    let ids = pairs
        .into_iter()
        .map(|(peer, counter)| {
            peer.parse::<u64>().map(|peer| ID::new(peer, counter)).map_err(|e| DendroidError::History(e.to_string()))
        })
        .collect::<Result<Vec<ID>>>()?;
    Ok(Frontiers::from(ids))
}

/// Every change in `doc`'s history, most recent first — walks
/// `travel_change_ancestors` from the current frontiers, which visits every
/// `Change` reachable from "now" in latest-to-oldest causal order (so this
/// is the document's whole history, not just one peer's).
pub fn history(doc: &LoroDoc) -> Result<Vec<HistoryEntryDto>> {
    let heads: Vec<ID> = doc.oplog_frontiers().iter().collect();
    let mut entries = Vec::new();

    doc.travel_change_ancestors(&heads, &mut |change: ChangeMeta| {
        // The frontiers right after this change landed — what `revert_to`
        // needs to land the document back here, including whatever came
        // before it.
        let end = ID::new(change.id.peer, change.id.counter + change.len as i32 - 1);
        entries.push(HistoryEntryDto {
            token: encode_token(&Frontiers::from(end)),
            timestamp: change.timestamp,
            message: change.message().to_string(),
            len: change.len,
        });
        ControlFlow::Continue(())
    })
    .map_err(|e| DendroidError::History(e.to_string()))?;

    Ok(entries)
}

/// Rolls `doc`'s state back to `token` (from a previous `history` call).
/// This is `LoroDoc::revert_to`, not `checkout` — see the module doc
/// comment for why: it applies the reverse diff as a new local operation
/// rather than detaching into a read-only past view, so the result is an
/// ordinary forward change any replica can merge, tagged with
/// `REVERT_COMMIT_MESSAGE` so it reads back distinctly in a later
/// `history()` call.
pub fn revert_to(doc: &LoroDoc, token: &str) -> Result<()> {
    let target = decode_token(token)?;
    doc.revert_to(&target)?;
    doc.set_next_commit_message(REVERT_COMMIT_MESSAGE);
    doc.commit();
    Ok(())
}
