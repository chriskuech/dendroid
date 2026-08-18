// A database's own change history — the History sidebar tab's other mode,
// shown instead of `HistoryView` (the markdown tree's) while a database is
// the content currently open in the main area (see Sidebar.tsx). Mirrors
// `HistoryView.tsx`'s layout and behavior closely on purpose (same
// row/Restore/Current shape) — `dendroid_core::sqldb::DbHistoryEntryDto`
// is deliberately shaped like `HistoryEntryDto` for exactly this reason.
// The one real difference: there's no live "onUpdate" stream to key a
// refetch off, so this listens to `db://update` instead (see `adapters/db`).

import { useCallback, useEffect, useState } from "react";
import type { DbHistoryEntryDto } from "../../adapters/db";
import { useDb } from "../../adapters/db/context";
import { HistoryIcon } from "../../ui/icons";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { SidePanelHeader } from "../../ui/SidePanelHeader";
import "./history.css";

interface DatabaseHistoryViewProps {
  databaseId: string;
}

/** Same "Today, 2:34 PM" / "Yesterday, 9:05 AM" / "Aug 3, 11:58 PM" shape
 * as HistoryView's `formatTimestamp` — kept as its own copy rather than a
 * shared import since the two `timestamp: 0` fallbacks mean slightly
 * different things (predates Loro's `set_record_timestamp` there; can't
 * happen here, since every `Exec` is stamped when it's first recorded) and
 * this reads more clearly as one self-contained file each. */
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

export function DatabaseHistoryView({ databaseId }: DatabaseHistoryViewProps) {
  const db = useDb();
  const [entries, setEntries] = useState<DbHistoryEntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<DbHistoryEntryDto | null>(null);
  const [restoring, setRestoring] = useState(false);

  const refresh = useCallback(() => {
    db.dbHistory(databaseId)
      .then((list) => {
        setEntries(list);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [databaseId, db]);

  useEffect(() => {
    setLoading(true);
    refresh();
    return db.onDatabasesChanged(refresh);
  }, [refresh, db]);

  const restore = useCallback(() => {
    if (!pending) return;
    setRestoring(true);
    db.dbRevertTo(databaseId, pending.token)
      .then(() => setPending(null))
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setRestoring(false));
  }, [databaseId, pending, db]);

  return (
    <div className="side-panel history-view">
      <SidePanelHeader icon={<HistoryIcon size={16} />} label="History" />
      <div className="history-view__rows">
        {loading ? (
          <div className="history-view__status">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="history-view__status">No changes recorded yet.</div>
        ) : (
          entries.map((entry, i) => (
            <div className="history-row" key={entry.token}>
              <div className="history-row__main">
                <span className="history-row__time">{formatTimestamp(entry.timestamp)}</span>
                <span className="history-row__desc">{entry.message}</span>
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
            ? `Restore this database to how it looked ${formatTimestamp(pending.timestamp)}. Nothing is erased — this adds a new change on top, so you can always roll forward again from History.`
            : ""
        }
        confirmLabel={restoring ? "Rolling back…" : "Roll back"}
        onConfirm={restore}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
