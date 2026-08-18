// The sidebar's database tab — list/create/delete, mirroring TreeView's/
// HistoryView's panel shape (header + scrollable rows) closely on purpose
// so all four tabs (Tree/Mind map/History/Databases) read as the same kind
// of sidebar content (see ux/sidebar/Sidebar.tsx). Selecting a row
// opens that database in the main area, replacing the Editor — see
// Workspace.tsx's `selectedDatabaseId`.

import { useCallback, useEffect, useState } from "react";
import type { DatabaseDto } from "../../adapters/db";
import { useDb } from "../../adapters/db/context";
import { DatabaseIcon, IncrementIcon, TrashIcon } from "../../ui/icons";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { SidePanelHeader } from "../../ui/SidePanelHeader";
import "./database.css";

interface DatabaseListViewProps {
  /** The database currently open in the main area, if any — its row gets
   * highlighted, same "always show current state" convention as
   * `.tree-row__reroot.is-root`. */
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function DatabaseListView({ selectedId, onSelect }: DatabaseListViewProps) {
  const db = useDb();
  const [databases, setDatabases] = useState<DatabaseDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DatabaseDto | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(() => {
    db.listDatabases()
      .then((list) => {
        setDatabases(list);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [db]);

  useEffect(() => {
    // Live off `db://update` the same way HistoryView stays live off the
    // CRDT's own `onUpdate` — a create/delete from this window or a merge
    // from another session/replica both land here.
    refresh();
    return db.onDatabasesChanged(refresh);
  }, [refresh, db]);

  const handleCreate = useCallback(() => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    db.createDatabase(name)
      .then((id) => {
        setNewName("");
        onSelect(id);
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setCreating(false));
  }, [newName, creating, onSelect, db]);

  const handleDelete = useCallback(() => {
    if (!pendingDelete) return;
    setDeleting(true);
    db.deleteDatabase(pendingDelete.id)
      .then(() => setPendingDelete(null))
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setDeleting(false));
  }, [pendingDelete, db]);

  return (
    <div className="side-panel database-list">
      <SidePanelHeader icon={<DatabaseIcon size={16} />} label="Databases" />
      <div className="database-list__new">
        <input
          className="database-list__new-input"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleCreate();
          }}
          placeholder="New database name…"
        />
        <button
          type="button"
          className="database-list__new-btn"
          disabled={!newName.trim() || creating}
          onClick={handleCreate}
          aria-label="Create database"
        >
          <IncrementIcon size={12} />
        </button>
      </div>
      <div className="database-list__rows">
        {loading ? (
          <div className="database-list__status">Loading…</div>
        ) : databases.length === 0 ? (
          <div className="database-list__status">No databases yet.</div>
        ) : (
          databases.map((database) => (
            <div
              key={database.id}
              className={`database-row${database.id === selectedId ? " is-active" : ""}`}
              onClick={() => onSelect(database.id)}
            >
              <DatabaseIcon size={12} />
              <span className="database-row__name">{database.name}</span>
              <span
                className="database-row__delete"
                title="Delete database"
                onClick={(event) => {
                  event.stopPropagation();
                  setPendingDelete(database);
                }}
              >
                <TrashIcon size={12} />
              </span>
            </div>
          ))
        )}
        {error && <div className="database-list__status database-list__status--error">{error}</div>}
      </div>
      <ConfirmDialog
        open={pendingDelete !== null}
        icon={TrashIcon}
        title="Delete database"
        body={pendingDelete ? `Permanently delete "${pendingDelete.name}" and everything in it? This can't be undone from History.` : ""}
        confirmLabel={deleting ? "Deleting…" : "Delete"}
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
