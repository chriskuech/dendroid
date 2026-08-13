//! Optional, local, symmetric encryption for ledger events — see the
//! whitepaper's "Encryption" section. There's no PKI here despite the
//! "private key" language the settings UI uses: `EncryptionKey` is a
//! single 256-bit shared secret, generated on one device and carried to
//! others either by showing it as a QR code or by copying/pasting its
//! textual form (`to_text`/`from_text`) — see
//! `doc::DendroidDocument::generate_encryption_key`/`set_encryption_key`
//! for where those two paths meet. Whoever holds the key can both encrypt
//! and decrypt, same as a password, which is why it never leaves this
//! device except through a deliberate, on-screen pairing action.
//!
//! Each ledger event is encrypted independently with ChaCha20-Poly1305 (an
//! AEAD: the ciphertext carries its own tamper-evidence, so a wrong key
//! fails loudly — `decrypt` — instead of silently returning garbage) and a
//! fresh random nonce that travels with the ciphertext (`encrypt`), so no
//! sequence-number or per-event bookkeeping is needed anywhere else in the
//! ledger.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Nonce,
};
use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::{DendroidError, Result};

const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;

/// Recognizable prefix on every textual/QR key, so pasting something that
/// obviously isn't one fails with a clear reason (`from_text`) instead of a
/// cryptic base64/length error.
const TEXT_PREFIX: &str = "dendroid-key1:";

/// A single shared secret used to encrypt (and decrypt) every ledger event
/// on a device — see the module doc comment. Deliberately has no `Debug`
/// derive that would print the raw bytes; `fingerprint` is the only
/// human-facing identifier for a key.
#[derive(Clone)]
pub struct EncryptionKey([u8; KEY_LEN]);

impl EncryptionKey {
    /// A fresh, random key — "create a key" in the enable-encryption
    /// prompt (`doc::DendroidDocument::generate_encryption_key`).
    pub fn generate() -> Self {
        let mut bytes = [0u8; KEY_LEN];
        OsRng.fill_bytes(&mut bytes);
        Self(bytes)
    }

    /// The textual form shown for copy/paste and encoded into the QR code
    /// ("Show QR to pair") — round-trips through `from_text`.
    pub fn to_text(&self) -> String {
        format!("{TEXT_PREFIX}{}", URL_SAFE_NO_PAD.encode(self.0))
    }

    /// Parses a key from its textual form — typed/pasted directly, or
    /// decoded from a scanned QR code (the QR just encodes this same
    /// string; see the settings UI's scan flow). Whitespace around it is
    /// trimmed so a copy/paste that picked up a stray newline still works.
    pub fn from_text(text: &str) -> Result<Self> {
        let text = text.trim();
        let encoded = text.strip_prefix(TEXT_PREFIX).ok_or_else(|| {
            DendroidError::InvalidEncryptionKey("doesn't look like a dendroid encryption key".to_string())
        })?;
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|e| DendroidError::InvalidEncryptionKey(format!("bad key encoding: {e}")))?;
        let bytes: [u8; KEY_LEN] =
            bytes.try_into().map_err(|_| DendroidError::InvalidEncryptionKey("wrong key length".to_string()))?;
        Ok(Self(bytes))
    }

    /// A short, stable, human-comparable identifier for this key — never
    /// enough to reconstruct it, just enough for two people to confirm
    /// "yes, that's the same key" (what Settings shows once a key is set).
    /// Grouped like `A1B2 C3D4 E5F6` for readability.
    pub fn fingerprint(&self) -> String {
        let digest = Sha256::digest(self.0);
        let hex: String = digest.iter().take(6).map(|b| format!("{b:02X}")).collect();
        hex.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).expect("hex is ASCII")).collect::<Vec<_>>().join(" ")
    }

    /// Encrypts `plaintext`, returning `nonce || ciphertext` — see
    /// `decrypt` for the inverse. Never fails: ChaCha20-Poly1305 has no
    /// failure mode for well-formed input of any length this crate ever
    /// produces (a Loro update blob).
    pub fn encrypt(&self, plaintext: &[u8]) -> Vec<u8> {
        let cipher = ChaCha20Poly1305::new(self.0.as_ref().into());
        let mut nonce_bytes = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = cipher.encrypt(nonce, plaintext).expect("chacha20poly1305 encryption cannot fail here");

        let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ciphertext);
        out
    }

    /// Inverse of `encrypt`. A wrong key (or corrupted/truncated data)
    /// fails the AEAD's authentication check and comes back as
    /// `DendroidError::WrongEncryptionKey` — deliberately not more
    /// specific than that, since telling apart "wrong key" from "tampered
    /// ciphertext" isn't something an AEAD can do, and isn't a
    /// distinction the UI needs anyway (`doc::DendroidDocument`'s
    /// `blocked_reason` treats both as "can't read this event").
    pub fn decrypt(&self, data: &[u8]) -> Result<Vec<u8>> {
        if data.len() < NONCE_LEN {
            return Err(DendroidError::WrongEncryptionKey);
        }
        let (nonce_bytes, ciphertext) = data.split_at(NONCE_LEN);
        let cipher = ChaCha20Poly1305::new(self.0.as_ref().into());
        cipher.decrypt(Nonce::from_slice(nonce_bytes), ciphertext).map_err(|_| DendroidError::WrongEncryptionKey)
    }
}

/// Encryption state for a workspace, as reported to a host (Tauri command,
/// wasm binding) and on to the Settings UI — see
/// `doc::DendroidDocument::encryption_status`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptionStatusDto {
    /// Whether a key is currently set on this device.
    pub enabled: bool,
    /// The current key's fingerprint, for display — `None` iff `!enabled`.
    pub fingerprint: Option<String>,
    /// Set the moment the ledger holds an event this device can't decrypt
    /// (no key, or the wrong one) — see `doc::DendroidDocument`'s
    /// `blocked_reason` field for exactly what that means for sync. `None`
    /// means sync is proceeding normally.
    pub blocked_reason: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_round_trips() {
        let key = EncryptionKey::generate();
        let text = key.to_text();
        assert!(text.starts_with(TEXT_PREFIX));
        let parsed = EncryptionKey::from_text(&text).unwrap();
        assert_eq!(key.fingerprint(), parsed.fingerprint());
    }

    #[test]
    fn from_text_rejects_garbage() {
        assert!(EncryptionKey::from_text("not a key").is_err());
        assert!(EncryptionKey::from_text("dendroid-key1:not-base64!!!").is_err());
    }

    #[test]
    fn encrypt_decrypt_round_trips() {
        let key = EncryptionKey::generate();
        let plaintext = b"a loro update blob, pretend";
        let ciphertext = key.encrypt(plaintext);
        assert_ne!(ciphertext, plaintext);
        assert_eq!(key.decrypt(&ciphertext).unwrap(), plaintext);
    }

    #[test]
    fn wrong_key_fails_to_decrypt() {
        let a = EncryptionKey::generate();
        let b = EncryptionKey::generate();
        let ciphertext = a.encrypt(b"secret");
        assert!(matches!(b.decrypt(&ciphertext), Err(DendroidError::WrongEncryptionKey)));
    }

    #[test]
    fn fingerprints_differ_between_keys() {
        let a = EncryptionKey::generate();
        let b = EncryptionKey::generate();
        assert_ne!(a.fingerprint(), b.fingerprint());
    }
}
