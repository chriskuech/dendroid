// The document's change history, read straight off the ledger (via
// `DendroidDocument.history()`) — a flat, most-recent-first list of every
// change Loro's oplog knows about, each with a "Restore" that rolls the
// live document back to right after that change (`DendroidDocument.
// revertTo`). Nothing here is ever erased: a rollback lands as a new entry
// at the top of this same list (see `dendroid_core::history`'s doc
// comment), so restoring an old version and then changing your mind is
// just another rollback away.

import { useCallback, useEffect, useState } from "react";
import type { DendroidDocument } from "../../lib/crdt/document";
import type { HistoryEntryDto } from "../../lib/crdt/history";
import { HistoryIcon } from "../icons";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import "../../styles/history.css";

interface HistoryViewProps {
  crdt: DendroidDocument;
}

/** "Today, 2:34 PM" / "Yesterday, 9:05 AM" / "Aug 3, 11:58 PM" — recent
 * points in history read at a glance; older ones still carry a date.
 * `timestamp` of `0` means this change predates timestamp recording (see
 * `HistoryEntryDto`), which is the one case worth calling out as unknown
 * rather than printing an epoch date that would just be confusing. */
function formatTimestamp(timestamp: number): string {
  if (!timestamp) return "Unknown time";

  const date = new Date(timestamp * 1000);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  const now = new Date();
  if (date.toDateString() === now.toDateString()) return `Today, ${time}`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;

  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/** A short description for a history row — the change's own commit
 * message when it has one (currently only ever `REVERT_COMMIT_MESSAGE`,
 * "Rollback"), otherwise a generic op-count fallback. */
function describeEntry(entry: HistoryEntryDto): string {
  if (entry.message) return entry.message;
  return entry.len === 1 ? "1 change" : `${entry.len} changes`;
}

export function HistoryView({ crdt }: HistoryViewProps) {
  const [entries, setEntries] = useState<HistoryEntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<HistoryEntryDto | null>(null);
  const [restoring, setRestoring] = useState(false);

  const refresh = useCallback(() => {
    crdt
      .history()
      .then((list) => {
        setEntries(list);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [crdt]);

  useEffect(() => {
    // Any change to the document — a local edit, a merge from another
    // session, or a rollback — can add a new history entry, so this stays
    // live off the same `onUpdate` signal the tree view's outline does.
    refresh();
    return crdt.onUpdate(refresh);
  }, [crdt, refresh]);

  const restore = useCallback(() => {
    if (!pending) return;
    setRestoring(true);
    crdt
      .revertTo(pending.token)
      .then(() => setPending(null))
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setRestoring(false));
  }, [crdt, pending]);

  return (
    <div className="history-view">
      <div className="history-view__header">
        <HistoryIcon size={16} />
        <span className="history-view__label">History</span>
      </div>
      <div className="history-view__rows">
        {loading ? (
          <div className="history-view__status">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="history-view__status">
            {crdt.isPreview ? "History isn't available in preview mode." : "No changes recorded yet."}
          </div>
        ) : (
          entries.map((entry, i) => (
            <div className="history-row" key={entry.token}>
              <div className="history-row__main">
                <span className="history-row__time">{formatTimestamp(entry.timestamp)}</span>
                <span className="history-row__desc">{describeEntry(entry)}</span>
              </div>
              {i > 0 && (
                <button type="button" className="history-row__restore" onClick={() => setPending(entry)}>
                  Restore
                </button>
              )}
              {i === 0 && <span className="history-row__current">Current</span>}
            </div>
          ))
        )}
        {error && <div className="history-view__status history-view__status--error">{error}</div>}
      </div>
      <ConfirmDialog
        open={pending !== null}
        icon={HistoryIcon}
        title="Roll back"
        body={
          pending
            ? `Restore the document to how it looked ${formatTimestamp(pending.timestamp)}. Nothing is erased — this adds a new change on top, so you can always roll forward again from History.`
            : ""
        }
        confirmLabel={restoring ? "Rolling back…" : "Roll back"}
        onConfirm={restore}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
