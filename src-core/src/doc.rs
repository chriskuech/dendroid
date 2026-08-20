//! Ties the CRDT, the transaction log (`ledger`), and a frontend-broadcast
//! checkpoint together into one handle a host (Tauri, a future CLI/MCP
//! server, tests, the web/wasm build) can drive. Generic over
//! `LedgerStorage` so the same logic works whether the ledger lives in real
//! files (native — see `crate::native`) or the browser's Origin Private
//! File System (web — see `dendroid-web`).
//!
//! `loro::VersionVector` never leaves this module — callers only see plain
//! ids, byte blobs, and DTOs, so hosts don't need `loro` as a direct
//! dependency at all.
//!
//! There's deliberately no *user-facing* structural mutation API here (no
//! create/rename/move/delete-node methods) — the document *is* what
//! `loro-prosemirror` edits directly in the frontend, and structure is
//! derived from it on read (see `outline`), not stored separately. Every
//! change reaches this type the same way, through `import_from_frontend`
//! (this session's own frontend mirror), `import_foreign_update` (a
//! genuinely external source), or `poll_external` (tailing the ledger).
//!
//! One narrow exception: after either of those imports something, this
//! type also runs `links::reconcile_backlinks` — derived-consistency
//! upkeep (closer to a database trigger than a structural API) that keeps
//! every `@`-link pointed at a heading that still exists, reparenting onto
//! the nearest surviving ancestor when its target got deleted. See
//! `links` for why that lives outside the same-choke-point rule rather
//! than breaking it.
//!
//! A second, one-time exception: `open` runs `migrate::migrate_flat_to_
//! sections` before anything else touches the freshly-replayed doc, for a
//! workspace whose ledger still predates the current nested-`section`
//! shape (see `crate::migrate`). Also not a user-facing structural API —
//! nothing calls it after startup, and it's a no-op the moment a workspace
//! is already on the current shape.

use loro::{ExportMode, LoroDoc, VersionVector};

use crate::crypto::{EncryptionKey, EncryptionStatusDto};
use crate::error::{DendroidError, Result};
use crate::history::{self, HistoryEntryDto};
use crate::ledger::{self, LedgerCursor, LedgerWriter, LoroUpdate, PolledRecord};
use crate::links;
use crate::markdown::{self, ApplyMode};
use crate::migrate;
use crate::outline::{self, HeadingDto, OutlineEntry};
use crate::storage::LedgerStorage;

pub struct DendroidDocument<S: LedgerStorage> {
    doc: LoroDoc,
    ledger: LedgerWriter<S>,
    cursor: LedgerCursor,
    /// What the frontend mirror has already been sent, so
    /// `export_updates_for_frontend` only ships the delta.
    frontend_vv: VersionVector,
    /// The outline as of the last time backlink reconciliation ran —
    /// `links::reconcile_backlinks` diffs against this to notice which
    /// heading ids just disappeared. Seeded once after the initial ledger
    /// replay in `open`.
    last_outline: Vec<HeadingDto>,
    /// This device's encryption key, if any — see the `crypto` module doc
    /// comment and `encryption_status`/`generate_encryption_key`/
    /// `set_encryption_key`/`remove_encryption_key` below. `None` is
    /// "encryption disabled" throughout this type; there's no separate
    /// on/off flag alongside a stored-but-inactive key.
    key: Option<EncryptionKey>,
    /// Records read off the ledger (during the initial replay in `open`,
    /// or a later `poll_external`) that couldn't be imported because
    /// they're encrypted and this device either has no key or the wrong
    /// one — see `import_records`. Kept, not dropped, so the exact right
    /// key supplied later (`set_key`, via `drain_pending`) still catches
    /// them up instead of having silently lost them.
    pending: Vec<PolledRecord<LoroUpdate>>,
    /// Set the moment `pending` gains a record, cleared the moment it
    /// fully drains. While set, `poll_external` is a deliberate no-op —
    /// "stop syncing" (see the whitepaper's encryption section) — rather
    /// than silently skipping the record the way a merely malformed line
    /// does; `encryption_status` surfaces this for the UI to show an error
    /// banner instead of pretending sync is still healthy.
    blocked_reason: Option<String>,
}

impl<S: LedgerStorage> DendroidDocument<S> {
    /// Opens (or creates) a workspace backed by `storage`: replays every
    /// existing ledger file into a fresh in-memory `LoroDoc` and opens this
    /// session's own ledger file for subsequent appends. A brand-new
    /// workspace's doc starts empty — there's nothing to bootstrap, since
    /// `loro-prosemirror` initializes its own root container lazily on
    /// first sync from the editor.
    pub async fn open(storage: S, session_id: impl Into<String>) -> Result<Self> {
        let doc = LoroDoc::new();
        // Off by default in Loro. Needed for `history` to show real
        // timestamps on whatever this process itself commits locally
        // (`migrate_legacy_shape`, `apply_markdown_and_append`, `revert_to`
        // below) — most local edits actually commit on the frontend's own
        // mirror instead (see `lib/crdt/document.ts`, which sets this same
        // flag on its own `LoroDoc` for the same reason), but MCP-driven
        // edits and rollbacks commit right here.
        doc.set_record_timestamp(true);

        let mut cursor: LedgerCursor<LoroUpdate> = LedgerCursor::new();
        let records = cursor.poll(&storage).await?;

        let ledger = LedgerWriter::open(storage, session_id).await?;

        let mut this = Self {
            doc,
            ledger,
            cursor,
            frontend_vv: VersionVector::default(),
            last_outline: Vec::new(),
            // No key yet at this point even on a device that has one set —
            // the key lives in the frontend's own persisted settings (see
            // `lib/crdt/document.ts`), which hands it back via
            // `set_encryption_key` right after `open` returns. If the
            // ledger holds encrypted events, this device is `blocked_
            // reason`-blocked for the brief window between those two calls
            // — no different in effect from being blocked because the key
            // hasn't arrived yet.
            key: None,
            pending: Vec::new(),
            blocked_reason: None,
        };
        this.import_records(records).await?;
        this.migrate_legacy_shape().await?;
        this.last_outline = outline::outline(&this.doc)?;

        Ok(this)
    }

    /// One-time upgrade for a workspace whose ledger still encodes the old
    /// flat document shape (every heading a top-level sibling, hierarchy
    /// inferred by comparing levels) into the current nested-`section`
    /// shape `outline`/`markdown` now expect — see `crate::migrate`. A
    /// no-op, checked on every open but cheap when there's nothing to do,
    /// for any workspace already migrated or newly created. Recorded as an
    /// ordinary ledger append, the same way `reconcile_and_append` records
    /// its own derived-consistency rewrites, so every replica converges on
    /// the same migrated shape the next time it syncs.
    async fn migrate_legacy_shape(&mut self) -> Result<()> {
        if !migrate::needs_migration(&self.doc)? {
            return Ok(());
        }
        let before = self.doc.oplog_vv();
        migrate::migrate_flat_to_sections(&self.doc)?;
        self.doc.commit();
        let delta = self.doc.export(ExportMode::updates(&before))?;
        self.append_delta(&delta).await
    }

    /// Appends `delta` (Loro update bytes) to this session's ledger file,
    /// unless it's empty — an empty delta means nothing actually changed
    /// (e.g. `import_and_ledger` importing bytes this doc already had). The
    /// old hand-written `LedgerWriter::append` used to skip those
    /// implicitly; now that `LedgerWriter` is generic over the payload,
    /// that Loro-specific "nothing to log" rule lives here instead.
    async fn append_delta(&mut self, delta: &[u8]) -> Result<()> {
        if delta.is_empty() {
            return Ok(());
        }
        let payload = match &self.key {
            Some(key) => LoroUpdate::new_encrypted(delta, key),
            None => LoroUpdate::new(delta),
        };
        self.ledger.append(payload).await
    }

    /// This session's current ledger file name (e.g.
    /// `2026-08-11.<uuid>.log`) — for tests/diagnostics, not identity.
    pub fn ledger_name(&self) -> String {
        self.ledger.name()
    }

    /// Derives the current heading outline by walking the document — see
    /// `outline::outline` for the encoding this depends on.
    pub fn outline(&self) -> Result<Vec<HeadingDto>> {
        outline::outline(&self.doc)
    }

    /// Headings and `@`-links, interleaved — what the tree view needs to
    /// render both. See `outline::outline_with_links`.
    pub fn outline_with_links(&self) -> Result<Vec<OutlineEntry>> {
        outline::outline_with_links(&self.doc)
    }

    /// Every `@`-link in the document, flat — mainly for tests and
    /// diagnostics; the live UI reads `outline_with_links` instead. See
    /// `links::find_link_refs`.
    pub fn links(&self) -> Result<Vec<links::LinkRefDto>> {
        links::find_link_refs(&self.doc)
    }

    /// Merge an update from a genuinely external source — another
    /// session's own edits arriving other than through `poll_external`
    /// (tests exercise this directly; nothing in this crate's own runtime
    /// path currently does). The frontend mirror hasn't seen this, so it
    /// stays eligible for the next `export_updates_for_frontend` call.
    pub async fn import_foreign_update(&mut self, bytes: &[u8]) -> Result<()> {
        self.import_and_ledger(bytes).await?;
        self.reconcile_and_append().await
    }

    /// Merge an update produced by *this session's own* frontend mirror
    /// (any local edit made through TipTap, via `doc.subscribeLocalUpdates`
    /// — what `doc_import_update` wraps). This process is the sole owner of
    /// the ledger file for this session, so even JS-originated edits get
    /// appended through this path.
    ///
    /// Unlike `import_foreign_update`, this marks the frontend as already
    /// caught up through `bytes` *before* reconciling — the frontend is
    /// where `bytes` came from, so echoing it straight back would violate
    /// `DocBackend.onRemoteUpdate`'s contract ("never for updates this same
    /// document produced locally", `lib/platform/types.ts`) and, worse,
    /// send `loro-prosemirror` down its non-local path: it can't tell an
    /// echo from a real remote change, so it tears down and rebuilds the
    /// whole ProseMirror document from the Loro map on every keystroke,
    /// racing whatever the user is still mid-typing (e.g. a heading whose
    /// stable id lands a transaction later — see `HeadingWithId`). A
    /// subsequent `export_updates_for_frontend` call still reports whatever
    /// this import's own backlink reconciliation added on top, since the
    /// frontend never saw that part.
    pub async fn import_from_frontend(&mut self, bytes: &[u8]) -> Result<()> {
        self.import_and_ledger(bytes).await?;
        self.frontend_vv = self.doc.oplog_vv();
        self.reconcile_and_append().await
    }

    /// Shared read-import-then-append-the-delta-to-the-ledger step behind
    /// both `import_foreign_update` and `import_from_frontend` — they only
    /// differ in what happens to `frontend_vv` afterward.
    async fn import_and_ledger(&mut self, bytes: &[u8]) -> Result<()> {
        let before = self.doc.oplog_vv();
        self.doc.import(bytes)?;
        let delta = self.doc.export(ExportMode::updates(&before))?;
        self.append_delta(&delta).await
    }

    /// Tail the ledger for records this process hasn't seen yet — written
    /// by another session of this app, or by another replica of the
    /// workspace entirely (e.g. a second device synced via iCloud Drive).
    /// Returns whether anything new was merged (including this session's
    /// own reconciliation of it, if any).
    ///
    /// Deliberately a no-op while `blocked_reason` is set — "stop
    /// syncing" the moment this device can't decrypt something, rather
    /// than skipping past it and merging everything after it as if
    /// nothing were wrong. See `import_records` and `set_key`/
    /// `drain_pending` for how that gets un-blocked.
    pub async fn poll_external(&mut self) -> Result<bool> {
        if self.blocked_reason.is_some() {
            return Ok(false);
        }

        let updates = self.cursor.poll(self.ledger.storage()).await?;
        if updates.is_empty() {
            return Ok(false);
        }
        self.import_records(updates).await?;
        self.reconcile_and_append().await?;
        Ok(true)
    }

    /// Imports every record in `records`, in order. The moment one can't
    /// be decoded because it's encrypted and this device either has no
    /// key or the wrong one, importing stops right there — that record
    /// and everything after it in `records` moves into `pending` instead
    /// of being imported or dropped, and `blocked_reason` is set (see that
    /// field's doc comment for why nothing past this point gets a chance
    /// to import either, even if some of it might have decoded fine on
    /// its own). A genuinely malformed record (bad base64, not an
    /// encryption problem) is still skipped with a logged warning as
    /// before — that's data corruption, which waiting for a key would
    /// never fix.
    async fn import_records(&mut self, mut records: Vec<PolledRecord<LoroUpdate>>) -> Result<()> {
        for i in 0..records.len() {
            match records[i].payload.decode(self.key.as_ref()) {
                Ok(bytes) => {
                    self.doc.import(&bytes)?;
                }
                Err(DendroidError::EncryptionRequired) | Err(DendroidError::WrongEncryptionKey) => {
                    self.blocked_reason = Some(if self.key.is_some() {
                        "An encrypted note couldn't be read with the current encryption key.".to_string()
                    } else {
                        "An encrypted note was found, but encryption is off on this device.".to_string()
                    });
                    self.pending.extend(records.split_off(i));
                    return Ok(());
                }
                Err(e) => eprintln!("[ledger] bad record, skipping: {e}"),
            }
        }
        Ok(())
    }

    /// Runs `links::reconcile_backlinks` against whatever just got
    /// imported, appends its rewrite (if any) to this session's own ledger
    /// file the same way any other local mutation is recorded, and updates
    /// `last_outline` for next time. Every replica that observes the same
    /// deletion resolves it independently and identically, so there's no
    /// need for a single "leader" replica to own this — Loro's CRDT merge
    /// makes the equivalent writes converge regardless of who made them.
    async fn reconcile_and_append(&mut self) -> Result<()> {
        let before = self.doc.oplog_vv();
        let changed = links::reconcile_backlinks(&self.doc, &self.last_outline)?;
        if changed {
            let delta = self.doc.export(ExportMode::updates(&before))?;
            self.append_delta(&delta).await?;
        }
        self.last_outline = outline::outline(&self.doc)?;
        Ok(())
    }

    /// Markdown for a slice of the document — see `markdown::resolve_slice`
    /// for exactly what "slice" means. What MCP's `getTree` wraps.
    pub fn get_tree(&self, root_id: Option<&str>, depth: u32, expand_links: bool, link_depth: u32) -> Result<String> {
        markdown::resolve_slice(&self.doc, root_id, depth, expand_links, link_depth)
    }

    /// Settings' "Storage > Materialize > Markdown" switch: the whole
    /// document, rendered as one plain markdown file — every heading at
    /// every depth, `@`-links left as bare references rather than inlined
    /// (unlike `get_tree`'s `expand_links`, there's no natural depth cap
    /// for "materialize everything" to pass instead). Purely a derived,
    /// disposable projection (see `src-tauri/src/materialize.rs`, which
    /// debounces writing this to disk) — the ledger stays the source of
    /// truth this is regenerated from on every call, not something this
    /// reads back.
    pub fn materialize_markdown(&self) -> Result<String> {
        markdown::resolve_slice(&self.doc, None, u32::MAX, false, 0)
    }

    /// Parses `content` and appends it inside `target_id`'s section — see
    /// `markdown::apply_markdown`. What MCP's `insert` wraps.
    pub async fn insert(&mut self, target_id: &str, content: &str) -> Result<()> {
        self.apply_markdown_and_append(target_id, content, ApplyMode::Insert).await
    }

    /// Parses `content` and replaces everything inside `target_id`'s
    /// section with it — see `markdown::apply_markdown`. What MCP's
    /// `replaceContent` wraps.
    pub async fn replace_content(&mut self, target_id: &str, content: &str) -> Result<()> {
        self.apply_markdown_and_append(target_id, content, ApplyMode::Replace).await
    }

    async fn apply_markdown_and_append(&mut self, target_id: &str, content: &str, mode: ApplyMode) -> Result<()> {
        let before = self.doc.oplog_vv();
        markdown::apply_markdown(&self.doc, target_id, content, mode)?;
        let delta = self.doc.export(ExportMode::updates(&before))?;
        self.append_delta(&delta).await?;
        // A `Replace` can delete headings (and anything that linked to
        // them) in the same edit — reconcile immediately rather than
        // waiting for the next import, the same way any other mutation
        // that can remove headings does.
        self.reconcile_and_append().await
    }

    /// Every change in this document's history, most recent first — what a
    /// history panel lists, each with a `token` `revert_to` (below) accepts
    /// to roll the document back to right after that change. See
    /// `history::history`.
    pub fn history(&self) -> Result<Vec<HistoryEntryDto>> {
        history::history(&self.doc)
    }

    /// Rolls the document back to `token` (from a previous `history` call).
    /// See `history::revert_to` for why this is `LoroDoc::revert_to`
    /// (applies the reverse diff as a new local change) rather than
    /// `checkout` (a read-only, detached time-travel view) — the short
    /// version is that a rollback needs to be an ordinary change any
    /// replica can merge and converge on, not a rewrite of history.
    /// Ledgered and reconciled exactly like `apply_markdown_and_append`:
    /// nothing here is a special case for other replicas that later import
    /// this same append.
    pub async fn revert_to(&mut self, token: &str) -> Result<()> {
        let before = self.doc.oplog_vv();
        history::revert_to(&self.doc, token)?;
        let delta = self.doc.export(ExportMode::updates(&before))?;
        self.append_delta(&delta).await?;
        // A rollback can resurrect or delete headings same as any other
        // mutation that touches document structure — reconcile immediately
        // rather than waiting for the next import.
        self.reconcile_and_append().await
    }

    /// Full snapshot for bootstrapping a brand-new frontend mirror.
    /// Resets the frontend checkpoint, so subsequent
    /// `export_updates_for_frontend` calls only ship what's new since now.
    pub fn export_snapshot_for_bootstrap(&mut self) -> Result<Vec<u8>> {
        let bytes = self.doc.export(ExportMode::Snapshot)?;
        self.frontend_vv = self.doc.oplog_vv();
        Ok(bytes)
    }

    /// Whatever has changed (from any source — an imported foreign update,
    /// or a `poll_external` merge) since the frontend mirror last heard
    /// from us. `None` means nothing to send.
    pub fn export_updates_for_frontend(&mut self) -> Result<Option<Vec<u8>>> {
        let now = self.doc.oplog_vv();
        if now == self.frontend_vv {
            return Ok(None);
        }
        let bytes = self.doc.export(ExportMode::updates(&self.frontend_vv))?;
        self.frontend_vv = now;
        Ok(Some(bytes))
    }

    // --- Encryption ----------------------------------------------------
    //
    // See the `crypto` module doc comment for the key model, and this
    // type's `key`/`pending`/`blocked_reason` fields for how a device
    // without the right key behaves. Everything below funnels into
    // `set_key`, the one place a key actually gets adopted.

    /// Current encryption state for the Settings UI: whether a key is set,
    /// its fingerprint, and why sync is currently blocked (if it is).
    pub fn encryption_status(&self) -> EncryptionStatusDto {
        EncryptionStatusDto {
            enabled: self.key.is_some(),
            fingerprint: self.key.as_ref().map(EncryptionKey::fingerprint),
            blocked_reason: self.blocked_reason.clone(),
        }
    }

    /// Turns on encryption with a freshly generated key — "create a key",
    /// one of the two choices the enable-encryption prompt offers (see the
    /// whitepaper). Returns the key's own textual form alongside the
    /// resulting status, so the caller can offer it immediately for a QR
    /// code or copy/paste — the only place this type ever exposes raw key
    /// material, because showing it *is* the pairing feature.
    pub async fn generate_encryption_key(&mut self) -> Result<(String, EncryptionStatusDto)> {
        let key = EncryptionKey::generate();
        let text = key.to_text();
        let status = self.set_key(key).await?;
        Ok((text, status))
    }

    /// Turns on encryption with `key_text` — the other half of the
    /// enable-encryption prompt ("add one from a QR code"), a scanned QR's
    /// decoded contents, or a pasted textual key. Also how a device that
    /// already has a key re-supplies it (e.g. once at every app start,
    /// after `set_key`'s persisted text round-trips back in — see `lib/
    /// crdt/document.ts`): idempotent, since there's nothing left to
    /// encrypt once everything already is, and any records `pending` from
    /// before are simply retried against this key.
    pub async fn set_encryption_key(&mut self, key_text: &str) -> Result<EncryptionStatusDto> {
        let key = EncryptionKey::from_text(key_text)?;
        self.set_key(key).await
    }

    /// Turns encryption off on this device. Deliberately touches nothing
    /// already on disk — every event already encrypted with the removed
    /// key stays exactly that way; per the whitepaper, dendroid can't
    /// recover it and holds no copy elsewhere. Any such event this device
    /// hasn't already imported goes right back to blocking sync the next
    /// time `poll_external` reaches it, the same as a device that never
    /// had a key.
    pub fn remove_encryption_key(&mut self) {
        self.key = None;
    }

    /// Adopts `key`: re-encrypts every currently-plaintext record already
    /// on disk with it ("all past events are encrypted", the moment
    /// encryption first turns on — anything already encrypted, e.g. from
    /// pairing with a workspace another device already encrypted, is left
    /// exactly as it is), sets it as this device's active key, and retries
    /// whatever `pending` couldn't be read before.
    async fn set_key(&mut self, key: EncryptionKey) -> Result<EncryptionStatusDto> {
        ledger::rewrite_payloads::<S, LoroUpdate, _>(self.ledger.storage(), |payload| {
            if payload.is_encrypted() {
                Ok(payload)
            } else {
                let bytes = payload.decode(None)?;
                Ok(LoroUpdate::new_encrypted(&bytes, &key))
            }
        })
        .await?;

        self.key = Some(key);
        self.drain_pending().await?;
        Ok(self.encryption_status())
    }

    /// Retries every record in `pending` against the current key (see
    /// `set_key`). Whatever still doesn't decode — e.g. `set_key` just
    /// got called with a key that isn't the one some of these were
    /// actually encrypted with — goes right back into `pending` rather
    /// than being lost, and `blocked_reason` stays set.
    async fn drain_pending(&mut self) -> Result<()> {
        if self.pending.is_empty() {
            self.blocked_reason = None;
            return Ok(());
        }
        let records = std::mem::take(&mut self.pending);
        // `blocked_reason` is left for `import_records` to re-derive (or
        // clear, on a `Ok(())` fall-through with nothing left blocked) —
        // it already knows how to distinguish "no key at all" from "a key,
        // just not the right one" for the message.
        self.blocked_reason = None;
        self.import_records(records).await
    }
}
