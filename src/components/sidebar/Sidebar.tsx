// The rail + swappable-content shell hosting TreeView and MindMapView.
// Both views used to own their own width/border/drawer-positioning/fade
// chrome individually (see TreeView.tsx) — that's lifted up here instead so
// a second view can share it, and neither view needs to know the other
// exists. TreeView itself is untouched: it's rendered here exactly like
// Workspace used to render it directly, just without `onClose`/`faded`/
// `transitionMs`/`drawerStyle` (this shell applies the equivalent styling
// to its own root instead, so TreeView always renders as its plain,
// fixed-width variant).

import type { CSSProperties } from "react";
import type { DendroidDocument } from "../../lib/crdt/document";
import type { OutlineEntry } from "../../lib/crdt/outline";
import { TreeView } from "../tree/TreeView";
import { MindMapView } from "../mindmap/MindMapView";
import { HistoryView } from "../history/HistoryView";
import { DatabaseHistoryView } from "../history/DatabaseHistoryView";
import { DatabaseListView } from "../database/DatabaseListView";
import { CloseIcon, DatabaseIcon, GraphIcon, HistoryIcon, LogoIcon } from "../icons";
import "../../styles/sidebar.css";

export type SidebarView = "tree" | "mindmap" | "history" | "database";

interface SidebarProps {
  view: SidebarView;
  onViewChange: (view: SidebarView) => void;
  /** Only needed for the "history" view (`HistoryView.crdt`) — `null`
   * while the document is still opening, same as `Workspace.tsx`'s own
   * `crdtRef` before `ready`. */
  crdt: DendroidDocument | null;
  entries: OutlineEntry[];
  collapsedIds: ReadonlySet<string>;
  expandedLinkIds: ReadonlySet<string>;
  previewDepth: number;
  rootId: string | null;
  onSelectHeading: (id: string) => void;
  onToggleCollapse: (id: string) => void;
  onToggleLinkExpand: (id: string) => void;
  onReroot: (id: string) => void;
  /** The database currently open in the main area, if any (see
   * Workspace.tsx). Drives two things here: the database list's active
   * row, and — while set — swaps the "history" tab from the markdown
   * tree's history to this database's own, the same way the main area
   * itself swaps from the Editor to a `DatabaseView`. */
  selectedDatabaseId: string | null;
  onSelectDatabase: (id: string) => void;
  /** Same "faded chrome" wiring TreeView used to apply to itself — see
   * Workspace.tsx's `chromeFaded`/`chromeTransitionMs`. Only meaningful for
   * the persistent (>=900px) sidebar; ignored once `drawerStyle` is given. */
  faded?: boolean;
  transitionMs?: number;
  /** Present only in the <900px drawer variant (see Workspace.tsx) — swaps
   * in a close button and lets the caller drive the deblur-in/out
   * transition from outside, same contract TreeView's own `onClose`/
   * `drawerStyle` used to have. */
  onClose?: () => void;
  drawerStyle?: CSSProperties;
}

export function Sidebar({
  view,
  onViewChange,
  crdt,
  entries,
  collapsedIds,
  expandedLinkIds,
  previewDepth,
  rootId,
  onSelectHeading,
  onToggleCollapse,
  onToggleLinkExpand,
  onReroot,
  selectedDatabaseId,
  onSelectDatabase,
  faded = false,
  transitionMs = 120,
  onClose,
  drawerStyle,
}: SidebarProps) {
  const style: CSSProperties = drawerStyle ?? {
    opacity: faded ? 0 : 1,
    pointerEvents: faded ? "none" : "auto",
    transition: `opacity ${transitionMs}ms cubic-bezier(0.2, 0, 0, 1)`,
  };

  return (
    <div className={`sidebar${onClose ? " sidebar--drawer" : ""}`} style={style}>
      <div className="sidebar__rail" role="tablist" aria-label="Sidebar view">
        <button
          type="button"
          role="tab"
          className={`sidebar__rail-btn${view === "tree" ? " is-active" : ""}`}
          aria-label="Tree"
          aria-selected={view === "tree"}
          onClick={() => onViewChange("tree")}
        >
          <LogoIcon size={16} />
        </button>
        <button
          type="button"
          role="tab"
          className={`sidebar__rail-btn${view === "mindmap" ? " is-active" : ""}`}
          aria-label="Mind map"
          aria-selected={view === "mindmap"}
          onClick={() => onViewChange("mindmap")}
        >
          <GraphIcon size={16} />
        </button>
        <button
          type="button"
          role="tab"
          className={`sidebar__rail-btn${view === "history" ? " is-active" : ""}`}
          aria-label="History"
          aria-selected={view === "history"}
          onClick={() => onViewChange("history")}
        >
          <HistoryIcon size={16} />
        </button>
        <button
          type="button"
          role="tab"
          className={`sidebar__rail-btn${view === "database" ? " is-active" : ""}`}
          aria-label="Databases"
          aria-selected={view === "database"}
          onClick={() => onViewChange("database")}
        >
          <DatabaseIcon size={16} />
        </button>
      </div>
      <div className="sidebar__content">
        {view === "tree" ? (
          <TreeView
            entries={entries}
            collapsedIds={collapsedIds}
            expandedLinkIds={expandedLinkIds}
            previewDepth={previewDepth}
            rootId={rootId}
            onSelectHeading={onSelectHeading}
            onToggleCollapse={onToggleCollapse}
            onToggleLinkExpand={onToggleLinkExpand}
            onReroot={onReroot}
          />
        ) : view === "mindmap" ? (
          <MindMapView entries={entries} onSelectHeading={onSelectHeading} />
        ) : view === "database" ? (
          <DatabaseListView selectedId={selectedDatabaseId} onSelect={onSelectDatabase} />
        ) : selectedDatabaseId ? (
          <DatabaseHistoryView databaseId={selectedDatabaseId} />
        ) : crdt ? (
          <HistoryView crdt={crdt} />
        ) : null}
      </div>
      {onClose && (
        <button type="button" className="sidebar__close" onClick={onClose} aria-label="Close sidebar">
          <CloseIcon size={16} />
        </button>
      )}
    </div>
  );
}
