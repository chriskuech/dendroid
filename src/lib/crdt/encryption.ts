// Mirrors `dendroid_core::crypto::EncryptionStatusDto`. See that module's
// doc comment for the key model — a single shared secret, not a PKI —
// and `DocBackend`'s `encryptionStatus`/`generateEncryptionKey`/
// `setEncryptionKey`/`removeEncryptionKey` for how the frontend drives it.

/** Encryption state for the current workspace, as reported by the backend
 * — what Settings' encryption panel renders and `Workspace.tsx`'s error
 * banner watches. */
export interface EncryptionStatusDto {
  /** Whether a key is currently set on this device. */
  enabled: boolean;
  /** The current key's short, human-comparable identifier — `null` iff
   * `!enabled`. Never enough to reconstruct the key itself. */
  fingerprint: string | null;
  /** Set the moment the ledger holds an event this device can't decrypt
   * (no key, or the wrong one) — sync stops until this clears (see
   * `DocBackend.setEncryptionKey`/`removeEncryptionKey`). `null` means
   * sync is proceeding normally. */
  blockedReason: string | null;
}

/** `generateEncryptionKey`'s result — `keyText` is the freshly created
 * key's textual form, for the caller to offer immediately as a QR code or
 * a copy-paste target (see `ux/settings/EncryptionPairing.tsx`). */
export interface GeneratedEncryptionKey {
  keyText: string;
  status: EncryptionStatusDto;
}
