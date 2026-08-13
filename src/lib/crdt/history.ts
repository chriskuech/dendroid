// Mirrors `dendroid_core::history::HistoryEntryDto`. See that module's doc
// comment for why rolling back is `revertTo` (a new forward change) rather
// than a destructive rewrite of the ledger.

/** One point in the document's history — what the History panel lists. */
export interface HistoryEntryDto {
  /** Opaque — round-trips through `DocBackend.revertTo`. Never inspect it. */
  token: string;
  /** Unix seconds, or `0` if this change predates timestamp recording
   * being turned on (a ledger written before this feature existed). */
  timestamp: number;
  /** The change's own commit message, e.g. "Rollback" for a prior rollback
   * — empty for an ordinary edit. */
  message: string;
  /** How many ops this change groups together — a rough size hint. */
  len: number;
}
