// The rail + swappable-content shell hosting TreeView and MindMapView.
// Both views used to own their own width/border/drawer-positioning/fade
// chrome individually (see TreeView.tsx) — that's lifted up here instead so
// a second view can share it, and neither view needs to know the other
// exists.
//
// Rendered two ways by Workspace.tsx: directly, as a persistent resizable
// column (>=900px, `faded`/`transitionMs` driving zen-mode's fade, `width`/
// `onResize` driving the drag handle), or as the sole child of a
// `ui/OverlayPanel.tsx` drawer (<900px) — the exact same component the
// right AgentPanel uses for its own drawer, so the two never drift out of
// sync on position/border/background/motion again. `onClose` is how this
// component tells which: given one, it assumes the OverlayPanel around it
// already owns position/background/border/width and just fills it, skipping
// the resize handle (the drawer isn't resizable) and swapping in a floating
// close button since drawer content has no header row to put one in.

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
import { SkillsView } from "../skills/SkillsView";
import { AutomationIcon, CloseIcon, DatabaseIcon, GraphIcon, HistoryIcon, LogoIcon, SettingsIcon, SkillIcon } from "../../ui/icons";
import "./sidebar.css";

export type SidebarView = "tree" | "mindmap" | "history" | "database" | "automation" | "skills";

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
  /** Opens the app's `SettingsPage` (owned by `Shell.tsx`, a Shell/Workspace
   * ancestor) — the rail's bottom button, formerly a standalone
   * `.settings-launcher` fixed over the whole window (see App.css), now
   * lives here instead. */
  onOpenSettings: () => void;
  /** Same "faded chrome" wiring TreeView used to apply to itself — see
   * Workspace.tsx's `chromeFaded`/`chromeTransitionMs`. Only meaningful for
   * the persistent (>=900px) sidebar; ignored once `onClose` is given. */
  faded?: boolean;
  transitionMs?: number;
  /** Content-column width (px, `AppSettings.sidebarWidth`) and its
   * pointerup commit callback, driving the drag handle on the sidebar's
   * right edge. See `lib/useResizableWidth.ts`. Only meaningful for the
   * persistent (>=900px) sidebar — the <900px drawer isn't resizable, so
   * both are ignored once `onClose` is given. */
  width: number;
  onResize: (width: number) => void;
  /** Present only in the <900px `OverlayPanel` drawer variant (see
   * Workspace.tsx) — swaps in a close button and skips the persistent
   * column's own position/border/background/resize handle, since the
   * OverlayPanel around it already supplies those. */
  onClose?: () => void;
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
  onOpenSettings,
  faded = false,
  transitionMs = 120,
  width,
  onResize,
  onClose,
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

  // Hook called unconditionally (Rules of Hooks) — its return is only used
  // below when this is the persistent (non-nested) column, via the content
  // width style and the resize handle's render guard.
  const { width: liveContentWidth, handleProps } = useResizableWidth({
    width,
    min: SIDEBAR_WIDTH_MIN,
    max: SIDEBAR_WIDTH_MAX,
    edge: "end",
    onResize,
  });

  // Nested (drawer) variant only: tapping the rail icon for the panel
  // that's already showing closes the drawer instead of re-selecting the
  // same view (a no-op that left the drawer stuck open). The persistent
  // column has no `onClose` and no drawer to close, so it keeps the plain
  // select-only behavior — clicking the active tab there is just a no-op.
  const handleRailClick = (targetView: SidebarView) => {
    if (onClose && view === targetView) {
      onClose();
      return;
    }
    onViewChange(targetView);
  };

  return (
    <div className={`sidebar${onClose ? " sidebar--nested" : ""}`} style={style}>
      <div className="sidebar__rail" role="tablist" aria-label="Sidebar view">
        <button
          type="button"
          role="tab"
          className={`sidebar__rail-btn${view === "tree" ? " is-active" : ""}`}
          aria-label="Tree"
          aria-selected={view === "tree"}
          onClick={() => handleRailClick("tree")}
        >
          <LogoIcon size={16} />
        </button>
        <button
          type="button"
          role="tab"
          className={`sidebar__rail-btn${view === "mindmap" ? " is-active" : ""}`}
          aria-label="Mind map"
          aria-selected={view === "mindmap"}
          onClick={() => handleRailClick("mindmap")}
        >
          <GraphIcon size={16} />
        </button>
        <button
          type="button"
          role="tab"
          className={`sidebar__rail-btn${view === "history" ? " is-active" : ""}`}
          aria-label="History"
          aria-selected={view === "history"}
          onClick={() => handleRailClick("history")}
        >
          <HistoryIcon size={16} />
        </button>
        <button
          type="button"
          role="tab"
          className={`sidebar__rail-btn${view === "database" ? " is-active" : ""}`}
          aria-label="Databases"
          aria-selected={view === "database"}
          onClick={() => handleRailClick("database")}
        >
          <DatabaseIcon size={16} />
        </button>
        <button
          type="button"
          role="tab"
          className={`sidebar__rail-btn${view === "automation" ? " is-active" : ""}`}
          aria-label="Automations"
          aria-selected={view === "automation"}
          onClick={() => handleRailClick("automation")}
        >
          <AutomationIcon size={16} />
        </button>
        <button
          type="button"
          role="tab"
          className={`sidebar__rail-btn${view === "skills" ? " is-active" : ""}`}
          aria-label="Skills"
          aria-selected={view === "skills"}
          onClick={() => handleRailClick("skills")}
        >
          <SkillIcon size={16} />
        </button>
        <button
          type="button"
          className="sidebar__rail-btn sidebar__rail-btn--settings"
          aria-label="Open settings"
          onClick={onOpenSettings}
        >
          <SettingsIcon size={16} />
        </button>
      </div>
      <div className="sidebar__content" style={onClose ? undefined : { width: `${liveContentWidth}px` }}>
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
        ) : view === "skills" ? (
          <SkillsView />
        ) : selectedDatabaseId ? (
          <DatabaseHistoryView databaseId={selectedDatabaseId} />
        ) : crdt ? (
          <HistoryView crdt={crdt} />
        ) : null}
      </div>
      {onClose ? (
        <button type="button" className="sidebar__close side-panel__icon-btn" onClick={onClose} aria-label="Close sidebar">
          <CloseIcon size={16} />
        </button>
      ) : (
        <div className="sidebar__resize-handle" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" {...handleProps} />
      )}
    </div>
  );
}
