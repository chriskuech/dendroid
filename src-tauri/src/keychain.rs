//! OS-keychain-backed storage for the device's encryption key (see
//! `dendroid_core::crypto`) — macOS Keychain, Windows Credential Manager,
//! or (on Linux) whatever Secret Service provider is running (GNOME
//! Keyring, KWallet's secret-service bridge, ...), via the `keyring`
//! crate. Every command here is a thin wrapper, same shape as
//! `commands.rs`, just synchronous rather than `async` — `keyring`'s API
//! has no async story of its own, and Tauri already runs a non-`async`
//! command on its own blocking-friendly thread rather than the async
//! runtime, so there's nothing to gain by pretending otherwise.
//!
//! Deliberately separate from `state::AppDocState` and everything in
//! `commands.rs`: this isn't part of a document session (no workspace
//! needs to be open to read/write it), and it never touches the ledger —
//! it's just where the *key itself* is kept between app restarts, handed
//! back to `dendroid_core::doc::DendroidDocument::set_encryption_key` by
//! the frontend once a workspace *is* open (see `lib/crdt/document.ts`'s
//! `open`, and `settingsStore.ts`'s `loadEncryptionKeyText`/
//! `saveEncryptionKeyText`/`clearEncryptionKeyText` for the JS side of
//! this same round trip).
//!
//! One entry, not one per workspace: dendroid only ever has one active
//! workspace at a time (the same simplification `settingsStore.ts`'s own
//! `WORKSPACE_KEY` already makes), so there's nowhere else for "which
//! workspace's key" to matter yet.

use keyring::Entry;

/// The keychain service name every entry this app creates is filed under
/// — matches `tauri.conf.json`'s `identifier`, the same string macOS
/// already uses to name this app's own `~/Library/Application Support`
/// directory, so a Keychain/Credential Manager entry reads as "obviously
/// dendroid's" next to every other app's.
const SERVICE: &str = "dev.kuech.dendroid";

/// Not a real user account — `keyring::Entry` is keyed by (service,
/// username) on every backend, so this is just the fixed logical name for
/// "the encryption key" within dendroid's own service namespace.
const ACCOUNT: &str = "encryption-key";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

/// This device's persisted encryption key text (see
/// `dendroid_core::crypto::EncryptionKey::to_text`), or `None` if nothing's
/// been stored yet — a missing keychain entry is the ordinary "never set"
/// case, not an error.
#[tauri::command(rename_all = "camelCase")]
pub fn keychain_get_encryption_key() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(text) => Ok(Some(text)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Stores `key_text`, overwriting whatever was there before — called right
/// after `DendroidDocument::generate_encryption_key`/`set_encryption_key`
/// succeeds (see `lib/crdt/document.ts`).
#[tauri::command(rename_all = "camelCase")]
pub fn keychain_set_encryption_key(key_text: String) -> Result<(), String> {
    entry()?.set_password(&key_text).map_err(|e| e.to_string())
}

/// Removes the stored key, if any — called alongside `encryption_remove_key`
/// (`commands.rs`) so the next app start doesn't just read it right back.
/// A missing entry is treated as already-deleted rather than an error, so
/// this stays idempotent (safe to call even if nothing was ever stored).
#[tauri::command(rename_all = "camelCase")]
pub fn keychain_delete_encryption_key() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
