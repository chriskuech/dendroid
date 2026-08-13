//! Abstracts the ledger's storage so `LedgerWriter`/`LedgerCursor` (and, in
//! turn, `DendroidDocument`) work identically whether records live in real
//! files (native — see `crate::native::NativeLedgerStorage`, `std::fs`
//! -backed) or a user-picked browser directory via the File System Access
//! API (web — see `dendroid-web`'s `FsaLedgerStorage`, which lives in that
//! crate instead of here since it needs `wasm-bindgen`/`web-sys`, not a
//! dependency of this platform-agnostic crate).
//!
//! One instance is scoped to a single workspace's ledger directory —
//! every method takes just a bare filename (e.g. `2026-08-11.<uuid>.log`),
//! never a directory argument. The web backend's directory handle has no
//! notion of an OS path, so directory scoping is something each impl's
//! constructor bakes in, not something this trait can express.
//!
//! Methods are `async` because the File System Access API's handle
//! methods are Promise-based end to end. `NativeLedgerStorage`'s
//! implementations just wrap synchronous `std::fs` calls in an `async fn`
//! that never actually suspends.

use crate::error::Result;

// Deliberately not desugared to `-> impl Future + Send`: `FsaLedgerStorage`
// (dendroid-web) captures `JsValue`/`web_sys` handles, which are `!Send`
// (wasm is single-threaded, so that's fine there). A `Send` bound would
// make that impl not compile. Nothing here needs `dyn LedgerStorage`, so
// losing dyn-compatibility costs nothing.
#[allow(async_fn_in_trait)]
pub trait LedgerStorage {
    /// Basenames of every ledger file currently present, unordered.
    async fn list_files(&self) -> Result<Vec<String>>;

    /// Current byte length of `name` (`0` if it doesn't exist).
    async fn len(&self, name: &str) -> Result<u64>;

    /// Bytes of `name` from `offset` to its current end. Empty if `name`
    /// doesn't exist or `offset` is at or past the current end.
    async fn read_from(&self, name: &str, offset: u64) -> Result<Vec<u8>>;

    /// Appends `bytes` to `name`, creating the file (and the ledger
    /// directory, if this is the first write) when it doesn't exist yet.
    /// Durable before this returns, to whatever extent the backend can
    /// promise that — native fsyncs; the web backend's writable-stream
    /// `close()` already flushes to disk.
    async fn append(&self, name: &str, bytes: &[u8]) -> Result<()>;

    /// Overwrites `name`'s entire contents with `bytes` (creating it if it
    /// doesn't exist yet). Unlike `append`, this breaks the ledger's
    /// "never mutated in place, only appended" rule (see this module's own
    /// doc comment and `ledger`'s) — the one deliberate exception is
    /// `ledger::rewrite_payloads`, which `doc::DendroidDocument` uses
    /// exactly once, to re-encrypt every already-written plaintext record
    /// in place the moment a device turns encryption on. Nothing else in
    /// this crate calls it.
    async fn write(&self, name: &str, bytes: &[u8]) -> Result<()>;
}
