//! Wasm bindings for the web build. Mirrors `src-tauri/src/commands.rs`'s
//! contract closely enough that the frontend's platform layer
//! (`src/lib/platform/`) can treat this and the Tauri IPC bridge as two
//! implementations of the same interface — same base64-over-the-wire
//! encoding for Loro bytes, same shape for the outline DTOs.
//!
//! Persistence goes through `fsa::FsaLedgerStorage`, the browser
//! equivalent of `dendroid_core::native::NativeLedgerStorage`'s
//! `std::fs` — a real user-picked directory via the File System Access
//! API, not origin-private OPFS, so a browser tab and a native Tauri
//! build of this app can point at the same folder. See that module for
//! how its Promise-based API makes `LedgerStorage` async everywhere.
//!
//! There's no background-polling thread here the way the Tauri build has
//! one (`src-tauri/src/lib.rs`'s ledger-tailing thread) — wasm has no
//! threads to spare for that. Instead `pollExternal` is exposed for the
//! frontend to call on its own interval (see `platform/wasm.ts`).
//!
//! There's also no `state.rs` here the way `src-tauri` has one: a Tauri
//! command runs stateless per-call and needs `AppDocState` to hand it the
//! session it's operating on, but `WebDocument` is a `#[wasm_bindgen]`
//! struct — the JS side holds one instance per open workspace, and `self`
//! plays the role `AppDocState`'s `Session` does on the Tauri side.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use dendroid_core::DendroidDocument;
use wasm_bindgen::prelude::*;
use web_sys::FileSystemDirectoryHandle;

use crate::fsa::FsaLedgerStorage;

#[wasm_bindgen]
pub struct WebDocument {
    inner: DendroidDocument<FsaLedgerStorage>,
}

#[wasm_bindgen]
impl WebDocument {
    /// Opens (creating if necessary) the `ledger/` subdirectory of
    /// `root` — a real directory handle the user picked via
    /// `window.showDirectoryPicker()` on the JS side (`lib/dialog.ts`'s
    /// `pickFolder`) and that's already been checked for read/write
    /// permission (`lib/platform/wasm.ts`). There's no OS path here —
    /// `root` *is* the workspace's identity, the same role
    /// `workspace_root: &Path` plays for the native/Tauri build.
    #[wasm_bindgen(js_name = open)]
    pub async fn open(root: FileSystemDirectoryHandle) -> Result<WebDocument, JsValue> {
        let storage = FsaLedgerStorage::open(root).await.map_err(to_js)?;
        let inner = DendroidDocument::open(storage, dendroid_core::new_session_id()).await.map_err(to_js)?;
        Ok(WebDocument { inner })
    }

    /// Full Loro snapshot, base64-encoded, for bootstrapping the
    /// frontend's own `LoroDoc` mirror — same contract as the Tauri
    /// `workspace_open` command's `snapshotB64`.
    #[wasm_bindgen(js_name = snapshotForBootstrap)]
    pub fn snapshot_for_bootstrap(&mut self) -> Result<String, JsValue> {
        Ok(STANDARD.encode(self.inner.export_snapshot_for_bootstrap().map_err(to_js)?))
    }

    /// Merge an update produced by the frontend's own Loro mirror — same
    /// contract as the Tauri `doc_import_update` command, including using
    /// `import_from_frontend` rather than `import_foreign_update` for the
    /// same reason that one does: this update *is* this tab's own edit,
    /// so it must not come back out of a later `exportUpdatesForFrontend`
    /// (reachable here via `pollExternal`, once something else prompts a
    /// broadcast) as if it were new.
    #[wasm_bindgen(js_name = importUpdate)]
    pub async fn import_update(&mut self, update_b64: String) -> Result<(), JsValue> {
        let bytes = STANDARD.decode(&update_b64).map_err(|e| JsValue::from_str(&e.to_string()))?;
        self.inner.import_from_frontend(&bytes).await.map_err(to_js)
    }

    /// Whatever's changed since the frontend mirror last heard from us,
    /// base64-encoded — same contract as the Tauri build's
    /// `crdt://update` event payload. `undefined` if there's nothing new.
    #[wasm_bindgen(js_name = exportUpdatesForFrontend)]
    pub fn export_updates_for_frontend(&mut self) -> Result<Option<String>, JsValue> {
        Ok(self.inner.export_updates_for_frontend().map_err(to_js)?.map(|bytes| STANDARD.encode(bytes)))
    }

    /// Tail the ledger for records another tab/session has written since
    /// we last checked, merge them in, and return the resulting delta
    /// (same encoding as `exportUpdatesForFrontend`) if anything merged.
    /// The frontend calls this on an interval — see this module's doc
    /// comment for why that replaces the Tauri build's background thread.
    #[wasm_bindgen(js_name = pollExternal)]
    pub async fn poll_external(&mut self) -> Result<Option<String>, JsValue> {
        if !self.inner.poll_external().await.map_err(to_js)? {
            return Ok(None);
        }
        self.export_updates_for_frontend()
    }

    /// Headless heading outline — same contract as the Tauri `doc_outline`
    /// command. The live UI reads this out of its own Loro mirror instead
    /// (see `lib/crdt/document.ts`'s `snapshotOutline`); this exists for
    /// parity and headless consumers.
    #[wasm_bindgen(js_name = outline)]
    pub fn outline(&self) -> Result<JsValue, JsValue> {
        let headings = self.inner.outline().map_err(to_js)?;
        serde_wasm_bindgen::to_value(&headings).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Every change in this document's history, most recent first — same
    /// contract as the Tauri `doc_history` command. See
    /// `dendroid_core::history::history`.
    #[wasm_bindgen(js_name = history)]
    pub fn history(&self) -> Result<JsValue, JsValue> {
        let entries = self.inner.history().map_err(to_js)?;
        serde_wasm_bindgen::to_value(&entries).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Rolls the document back to `token` (a history entry's own `token`
    /// field) — same contract as the Tauri `doc_revert_to` command. Unlike
    /// Tauri, there's no separate broadcast channel here: the caller reads
    /// the resulting delta back out via `exportUpdatesForFrontend` (see
    /// `lib/platform/wasm.ts`'s `revertTo`), same as it already does after
    /// `pollExternal`.
    #[wasm_bindgen(js_name = revertTo)]
    pub async fn revert_to(&mut self, token: String) -> Result<(), JsValue> {
        self.inner.revert_to(&token).await.map_err(to_js)
    }
}

fn to_js(e: dendroid_core::DendroidError) -> JsValue {
    JsValue::from_str(&e.to_string())
}
