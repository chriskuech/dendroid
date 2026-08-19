// The TipTap <-> CRDT <-> Ledger <-> files pipeline, assembled:
//
//   Workspace
//     |-- DendroidDocument (lib/crdt/document.ts) — the frontend Loro
//     |   mirror; opens the workspace (replays the ledger on the Rust
//     |   side), then stays live via the "crdt://update" event.
//     |-- Sidebar (ux/sidebar/Sidebar.tsx) — a rail switching
//     |   between two read-only views of the same outline
//     |   (lib/crdt/document.ts's snapshotOutlineWithLinks):
//     |     |-- TreeView — row-per-heading navigation. Expand/collapse
//     |     |   state is mirrored here from the editor's headingFold
//     |     |   plugin, so folding a heading in either place folds it in
//     |     |   both.
//     |     `-- MindMapView — the same outline as a draggable node graph.
//     `-- Editor — TipTap bound to the *whole* document directly through
//         loro-prosemirror; there is no per-node scoping anymore.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppState } from "../../lib/AppState";
import { DendroidDocument } from "../../lib/crdt/document";
import type { OutlineEntry } from "../../lib/crdt/outline";
import type { DatabaseDto } from "../../adapters/db";
import { useAutomationsEngine } from "../../adapters/automationsEngine/context";
import { useDb } from "../../adapters/db/context";
import { useMcp } from "../../adapters/mcp/context";
import { Sidebar, type SidebarView } from "../sidebar/Sidebar";
import { AgentPanel } from "../agent/AgentPanel";
import { AgentIcon, LogoIcon, WarningIcon } from "../../ui/icons";
import { Editor, type EditorHandle } from "../editor/Editor";
import { DatabaseView } from "../database/DatabaseView";
import { Banner } from "../../ui/Banner";
import { OverlayPanel } from "../../ui/OverlayPanel";
import "./workspace.css";

interface WorkspaceProps {
  rootPath: string;
  /** Hands the live `DendroidDocument` instance up to `Shell` (`App.tsx`)
   * once it's open, so a sibling `SettingsPage` can drive the same
   * document's encryption controls — `Workspace` still owns opening/
   * disposing it, this is just a way to share the reference. Called with
   * `null` on unmount/rootPath change. */
  onDocumentReady?: (crdt: DendroidDocument | null) => void;
  /** Opens `Shell`'s `SettingsPage` — `Shell` still owns the open/close
   * state (and the encryption panel's `crdt` handoff above), this is just
   * the trigger, threaded down to `Sidebar`'s rail button. */
  onOpenSettings: () => void;
}

export function Workspace({ rootPath, onDocumentReady, onOpenSettings }: WorkspaceProps) {
  const { workspace, settings, isNarrow, setEditorFocused, chromeFaded, chromeTransitionMs, updateSettings } = useAppState();
  const db = useDb();
  const mcp = useMcp();
  const automationsEngine = useAutomationsEngine();
  const crdtRef = useRef<DendroidDocument | null>(null);
  const editorRef = useRef<EditorHandle>(null);
  const [ready, setReady] = useState(false);
  const [entries, setEntries] = useState<OutlineEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Set the moment the ledger holds an encrypted event this device can't
  // read (no key, or the wrong one) — see `dendroid_core::doc::
  // DendroidDocument`'s `blocked_reason`. Sync is genuinely stopped while
  // this is set (`poll_external` no-ops), not just visually flagged — the
  // banner below is what tells the user why nothing new is coming in.
  const [encryptionBlockedReason, setEncryptionBlockedReason] = useState<string | null>(null);
  // Which panel the sidebar/drawer currently shows — Tree or the mindmap
  // graph (see ux/sidebar/Sidebar.tsx). Shared between the wide
  // sidebar and the narrow drawer so switching in one is remembered by the
  // other.
  const [sidebarView, setSidebarView] = useState<SidebarView>("tree");
  // The editor's headingFold plugin is the source of truth (see
  // Editor.tsx / ux/editor/tiptap/headingFold.ts) — this is just its state
  // mirrored down so the tree view can render the same folds. Toggling
  // from the tree goes back through an editor command rather than
  // touching this directly, so both surfaces never disagree.
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set());
  // Same mirroring story as `collapsedIds`, for whichever `@`-links the
  // editor's linkRef plugin currently has expanded — see ux/editor/tiptap/linkRef.ts.
  const [expandedLinkIds, setExpandedLinkIds] = useState<ReadonlySet<string>>(() => new Set());
  // Same mirroring story as `collapsedIds`, for whichever heading (if any)
  // the editor's docRoot plugin currently has scoped as the root.
  const [rootId, setRootId] = useState<string | null>(null);
  // The database currently open in the main area, if any — set by picking
  // a row in the sidebar's Databases tab (see Sidebar.tsx's
  // `onSelectDatabase`). `selectedDatabase` is the resolved DTO (for
  // `DatabaseView`'s header); kept separate from the bare id so a delete
  // from elsewhere (another window, another session merged in via
  // `db://update`) can be noticed and fall back to the Editor rather than
  // rendering a `DatabaseView` for a database that no longer exists.
  const [selectedDatabaseId, setSelectedDatabaseId] = useState<string | null>(null);
  const [selectedDatabase, setSelectedDatabase] = useState<DatabaseDto | null>(null);
  // Whether the right-side agent chat drawer is open — see
  // ux/agent/AgentPanel.tsx. Unlike `drawerView`/`sidebarView`,
  // there's no wide/narrow split for this one: it's always an overlay (see
  // ux/agent/agent.css), so a single boolean is all either layout
  // needs.
  const [agentOpen, setAgentOpen] = useState(false);

  useEffect(() => {
    if (!selectedDatabaseId) {
      setSelectedDatabase(null);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      db.getDatabase(selectedDatabaseId).then((database) => {
        if (cancelled) return;
        setSelectedDatabase(database);
        if (!database) setSelectedDatabaseId(null);
      });
    };
    refresh();
    const unsubscribe = db.onDatabasesChanged(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [selectedDatabaseId, db]);

  useEffect(() => {
    let cancelled = false;
    const crdt = new DendroidDocument();
    crdtRef.current = crdt;

    const refreshOutline = () => setEntries(crdt.snapshotOutlineWithLinks());
    const unsubscribe = crdt.onUpdate(refreshOutline);
    const unsubscribeEncryption = crdt.onEncryptionStatusChange((status) => setEncryptionBlockedReason(status.blockedReason));

    crdt
      .open(rootPath)
      .then(() => {
        if (cancelled) return;
        setReady(true);
        onDocumentReady?.(crdt);
      })
      .catch((err: unknown) => setError(String(err)));

    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeEncryption();
      crdt.dispose();
      crdtRef.current = null;
      onDocumentReady?.(null);
      setEncryptionBlockedReason(null);
    };
    // `onDocumentReady` deliberately isn't a dependency here — it's a
    // stable setState callback from `Shell` (`App.tsx`), and this effect
    // should only re-run when the workspace itself changes.
  }, [rootPath]);

  // Covers the cold-start case `AppState.tsx`'s own `applyMcpConfig` effect
  // can't: "Local MCP" already enabled from a previous session, before
  // this window's `workspace_open` (and so `AppDocState::primary_label`)
  // has actually run. `AppState`'s effect covers every change after this
  // one fires — this is only about not missing the very first.
  useEffect(() => {
    if (ready) void mcp.applyMcpConfig(settings.mcp);
  }, [ready, settings.mcp, mcp]);

  // Tells the automation engine (src-tauri/src/automation.rs) which cwd to
  // spawn its agent processes in, and re-syncs it whenever this workspace's
  // root or the configured agent command/args change — see
  // adapters/automationsEngine's doc comment for why this lives here rather
  // than in the automations tab itself (automations aren't workspace-scoped,
  // but the engine still needs *some* cwd to launch the agent binary in).
  useEffect(() => {
    if (!ready) return;
    automationsEngine.setAutomationsCwd(rootPath);
    return () => automationsEngine.setAutomationsCwd(null);
  }, [ready, rootPath, automationsEngine]);

  useEffect(() => {
    if (ready) void automationsEngine.syncAutomationsEngine();
  }, [ready, settings.agent, automationsEngine]);

  const selectHeading = useCallback((headingId: string) => {
    const editor = editorRef.current?.editor;
    if (!editor) return;

    let sectionPos: number | null = null;
    editor.state.doc.descendants((node, pos) => {
      if (sectionPos !== null) return false;
      if (node.type.name === "section" && node.attrs.id === headingId) {
        sectionPos = pos;
        return false;
      }
      return true;
    });
    if (sectionPos === null) return;

    const dom = editor.view.nodeDOM(sectionPos) as HTMLElement | null;
    dom?.scrollIntoView({ behavior: "smooth", block: "start" });
    // sectionPos = the section's own opening; +1 = its heading's own
    // opening; +1 = the start of the heading's own (inline) content.
    editor.commands.setTextSelection(sectionPos + 2);
    editor.commands.focus();
  }, []);

  const toggleHeadingCollapse = useCallback((headingId: string) => {
    editorRef.current?.editor?.commands.toggleHeadingFold(headingId);
  }, []);

  const toggleLinkExpand = useCallback((linkId: string) => {
    editorRef.current?.editor?.commands.toggleLinkExpand(linkId);
  }, []);

  const reroot = useCallback((headingId: string) => {
    editorRef.current?.editor?.commands.toggleDocumentRoot(headingId);
  }, []);

  // `isNarrow` and `chromeFaded` both live in AppState now, not here — zen
  // mode needs to fade chrome outside Workspace too (the settings launcher
  // in App.tsx), so both are computed once at that level and read down.
  // The persistent sidebar and the <900px drawer both render `Sidebar`, but
  // only the persistent one fades for zen mode — the drawer already starts
  // hidden and is opened deliberately, rather than idled into view. The
  // narrow topbar (hamburger + breadcrumb, below) isn't part of that
  // sidebar/drawer pair but is still chrome outside the editor, so it
  // fades on its own.

  // A drawer left open when the viewport widens back past the breakpoint
  // would otherwise become an inert, never-closeable sidebar duplicate.
  useEffect(() => {
    if (!isNarrow) setDrawerOpen(false);
  }, [isNarrow]);

  // "Dendroid / Notes are a graph" style breadcrumb (comp/Dendroid
  // Screens.dc.html section "03 Tree", <900px variant) — workspace name,
  // plus whatever heading the editor is currently rooted to.
  const rootHeadingTitle = rootId ? findHeadingTitle(entries, rootId) : null;
  const breadcrumb = [workspace?.name ?? "Dendroid", rootHeadingTitle].filter(Boolean).join(" / ");

  // Selecting a heading from the drawer should also close it — staying
  // open over the now-navigated-to content would just be in the way. Kept
  // above the early returns below (Rules of Hooks: every hook here has to
  // run on every render, loading/error states included).
  const selectHeadingFromDrawer = useCallback(
    (headingId: string) => {
      selectHeading(headingId);
      setDrawerOpen(false);
    },
    [selectHeading],
  );

  if (error) {
    return <div className="workspace__status workspace__status--error">Couldn't open workspace: {error}</div>;
  }

  if (!ready || !crdtRef.current) {
    return <div className="workspace__status">Loading workspace…</div>;
  }

  const treeViewProps = {
    entries,
    collapsedIds,
    expandedLinkIds,
    previewDepth: settings.descendantDepth,
    rootId,
    onSelectHeading: isNarrow ? selectHeadingFromDrawer : selectHeading,
    onToggleCollapse: toggleHeadingCollapse,
    onToggleLinkExpand: toggleLinkExpand,
    onReroot: reroot,
  };

  // One <Editor> in one stable tree position regardless of `isNarrow` — two
  // separate `return`s for the wide/narrow layouts would each mount their
  // own copy, and crossing the breakpoint mid-edit would remount it
  // (losing cursor position and focus) purely because of window width.
  return (
    <div className={`workspace${isNarrow ? " workspace--narrow" : ""}`}>
      {encryptionBlockedReason && <Banner icon={WarningIcon}>{encryptionBlockedReason} Sync is stopped until this is resolved in Settings.</Banner>}
      {isNarrow ? (
        <div
          className="workspace__topbar"
          style={{
            // Same chrome-fade wiring as the sidebar/settings launcher (see
            // useZenChrome / AppState's `chromeFaded`) — the hamburger and
            // breadcrumb are the narrow layout's only chrome outside the
            // editor, so zen mode fades them too rather than leaving this
            // one strip permanently visible.
            opacity: chromeFaded ? 0 : 1,
            pointerEvents: chromeFaded ? "none" : "auto",
            transition: `opacity ${chromeTransitionMs}ms cubic-bezier(0.2, 0, 0, 1)`,
          }}
        >
          <button
            type="button"
            className="workspace__hamburger"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open tree"
          >
            <LogoIcon size={16} />
          </button>
          <span className="workspace__breadcrumb">{breadcrumb}</span>
        </div>
      ) : (
        <Sidebar
          {...treeViewProps}
          crdt={crdtRef.current}
          view={sidebarView}
          onViewChange={setSidebarView}
          selectedDatabaseId={selectedDatabaseId}
          onSelectDatabase={setSelectedDatabaseId}
          onOpenSettings={onOpenSettings}
          faded={chromeFaded}
          transitionMs={chromeTransitionMs}
          width={settings.sidebarWidth}
          onResize={(sidebarWidth) => updateSettings({ sidebarWidth })}
        />
      )}

      <div
        className="workspace__editor"
        style={
          isNarrow
            ? {
                filter: `blur(${drawerOpen ? 2 : 0}px)`,
                transition: `filter ${drawerOpen ? 200 : 130}ms cubic-bezier(0.2, 0, 0, 1)`,
              }
            : undefined
        }
      >
        {selectedDatabase ? (
          <DatabaseView database={selectedDatabase} onClose={() => setSelectedDatabaseId(null)} />
        ) : (
          <Editor
            ref={editorRef}
            crdt={crdtRef.current}
            initialExpandedDepth={settings.descendantDepth}
            onFoldChange={setCollapsedIds}
            onRootChange={setRootId}
            onLinkExpandChange={setExpandedLinkIds}
            onNavigateLink={selectHeading}
            onFocusChange={setEditorFocused}
            auralFeedback={settings.auralFeedback}
          />
        )}
      </div>

      {isNarrow && (
        // The exact same `OverlayPanel` shell AgentPanel.tsx uses on the
        // right (see its doc comment) — same slide motion, backdrop, and
        // border/background, just anchored to the left edge instead.
        <OverlayPanel side="left" open={drawerOpen} onOpenChange={setDrawerOpen} title="Tree" onBackdropClick={() => setDrawerOpen(false)}>
          <Sidebar
            {...treeViewProps}
            crdt={crdtRef.current}
            view={sidebarView}
            onViewChange={setSidebarView}
            selectedDatabaseId={selectedDatabaseId}
            onSelectDatabase={setSelectedDatabaseId}
            onOpenSettings={() => {
              setDrawerOpen(false);
              onOpenSettings();
            }}
            onClose={() => setDrawerOpen(false)}
          />
        </OverlayPanel>
      )}

      <button
        type="button"
        className={`agent-toggle${agentOpen ? " is-active" : ""}`}
        onClick={() => setAgentOpen((v) => !v)}
        aria-label={agentOpen ? "Close agent chat" : "Open agent chat"}
        style={{
          opacity: chromeFaded ? 0 : 1,
          pointerEvents: chromeFaded ? "none" : "auto",
          transition: `opacity ${chromeTransitionMs}ms cubic-bezier(0.2, 0, 0, 1)`,
        }}
      >
        <AgentIcon size={16} />
      </button>
      <AgentPanel
        cwd={rootPath}
        agentSettings={settings.agent}
        mcpSettings={settings.mcp}
        open={agentOpen}
        onClose={() => setAgentOpen(false)}
        width={settings.agentPanelWidth}
        onResize={(agentPanelWidth) => updateSettings({ agentPanelWidth })}
      />
    </div>
  );
}

function findHeadingTitle(entries: OutlineEntry[], id: string): string | null {
  const entry = entries.find((e) => e.kind === "heading" && e.heading.id === id);
  return entry?.kind === "heading" ? entry.heading.title : null;
}
