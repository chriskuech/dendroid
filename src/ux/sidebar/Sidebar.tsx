// The rail + swappable-content shell hosting TreeView and MindMapView.
// Both views used to own their own width/border/drawer-positioning/fade
// chrome individually (see TreeView.tsx) — that's lifted up here instead so
// a second view can share it, and neither view needs to know the other
// exists.
//
// Rendered two ways by Workspace.tsx: directly, as a persistent column
// (>=900px, `faded`/`transitionMs` driving zen-mode's fade), or as the sole
// child of a `ui/OverlayPanel.tsx` drawer (<900px) — the exact same
// component the right AgentPanel uses for its own drawer, so the two never
// drift out of sync on position/border/background/motion again. `onClose`
// is how this component tells which: given one, it assumes the
// OverlayPanel around it already owns position/background/border and just
// fills it, swapping in a floating close button since drawer content has
// no header row to put one in.

import type { CSSProperties } from "react";
import type { DendroidDocument } from "../../lib/crdt/document";
import type { OutlineEntry } from "../../lib/crdt/outline";
import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from "../../lib/types";
import { useResizableWidth } from "../../lib/useResizableWidth";
import { TreeView } from "../tree/TreeView";
import { MindMapView } from "../mindmap/MindMapView";
import { HistoryView } from "../history/HistoryView";
import { DatabaseHistoryView } from "../history/DatabaseHistoryView";
import { DatabaseListView } from "../database/DatabaseListView";
import { AutomationsView } from "../automations/AutomationsView";
import { AutomationIcon, CloseIcon, DatabaseIcon, GraphIcon, HistoryIcon, LogoIcon } from "../../ui/icons";
import "./sidebar.css";

export type SidebarView = "tree" | "mindmap" | "history" | "database" | "automation";

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
  /** Present only in the <900px `OverlayPanel` drawer variant (see
   * Workspace.tsx) — swaps in a close button and skips the persistent
   * column's own position/border/background, since the OverlayPanel around
   * it already supplies those. */
  onClose?: () => void;
  /** Content-column width (px, `AppSettings.sidebarWidth`) and its
   * pointerup commit callback — given together, and only by the
   * persistent (>=900px) sidebar; the <900px drawer sizes itself from
   * content instead and omits both, which also skips rendering the resize
   * handle. See `lib/useResizableWidth.ts`. */
  width?: number;
  onResize?: (width: number) => void;
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
  width,
  onResize,
}: SidebarProps) {
  // Nested inside an OverlayPanel, which owns the fade/slide-in motion
  // itself (see ui/OverlayPanel.tsx) — only the persistent column drives
  // its own opacity, for zen mode.
  const style: CSSProperties | undefined = onClose
    ? undefined
    : {
        opacity: faded ? 0 : 1,
        pointerEvents: faded ? "none" : "auto",
        transition: `opacity ${transitionMs}ms cubic-bezier(0.2, 0, 0, 1)`,
      };

  // Hook called unconditionally (Rules of Hooks) — only used below when
  // `width`/`onResize` are actually given (the persistent sidebar).
  const resizable = width !== undefined && onResize !== undefined;
  const { width: liveContentWidth, handleProps } = useResizableWidth({
    width: width ?? SIDEBAR_WIDTH_MIN,
    min: SIDEBAR_WIDTH_MIN,
    max: SIDEBAR_WIDTH_MAX,
    edge: "end",
    onResize: onResize ?? (() => {}),
  });

  return (
    <div className={`sidebar${onClose ? " sidebar--nested" : ""}`} style={style}>
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
        <button
          type="button"
          role="tab"
          className={`sidebar__rail-btn${view === "automation" ? " is-active" : ""}`}
          aria-label="Automations"
          aria-selected={view === "automation"}
          onClick={() => onViewChange("automation")}
        >
          <AutomationIcon size={16} />
        </button>
      </div>
      <div className="sidebar__content" style={resizable ? { width: `${liveContentWidth}px` } : undefined}>
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
        ) : view === "automation" ? (
          <AutomationsView />
        ) : selectedDatabaseId ? (
          <DatabaseHistoryView databaseId={selectedDatabaseId} />
        ) : crdt ? (
          <HistoryView crdt={crdt} />
        ) : null}
      </div>
      {onClose && (
        <button type="button" className="sidebar__close side-panel__icon-btn" onClick={onClose} aria-label="Close sidebar">
          <CloseIcon size={16} />
        </button>
      )}
      {resizable && (
        <div className="sidebar__resize-handle" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" {...handleProps} />
      )}
    </div>
  );
}
