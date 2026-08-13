import { useEffect, useState } from "react";
import { AppStateProvider, useAppState } from "./lib/AppState";
import type { DendroidDocument } from "./lib/crdt/document";
import { pickFolder } from "./lib/dialog";
import { folderNameFromPath } from "./lib/path";
import { WorkspaceOnboarding } from "./components/onboarding/WorkspaceOnboarding";
import { SettingsPage } from "./components/settings/SettingsPage";
import { Workspace } from "./components/workspace/Workspace";
import { SettingsIcon } from "./components/icons";
import "./App.css";

// Mirrors the check `dialog.ts`/`platform/index.ts` do — only a Tauri
// build has a native menu (and `@tauri-apps/api/event` to listen with) at
// all, so a plain web build never pulls that module in.
function hasTauriBridge(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Fired by the Rust side (`src-tauri/src/lib.rs`'s `build_menu`) when the
 * native "Settings" menu item is picked. */
const OPEN_SETTINGS_EVENT = "menu://open-settings";

/** Fired by the Rust side (`src-tauri/src/lib.rs`'s `build_menu`) when the
 * native "File > New Workspace" menu item is picked. */
const NEW_WORKSPACE_EVENT = "menu://new-workspace";

/** Fired by the Rust side (`src-tauri/src/lib.rs`'s `build_menu`) when the
 * native "File > Open Workspace…" menu item is picked. */
const OPEN_WORKSPACE_EVENT = "menu://open-workspace";

/** Fired by the Rust side (`src-tauri/src/lib.rs`'s `build_menu`) when the
 * native "File > Open Workspace in New Window…" menu item is picked. */
const OPEN_WORKSPACE_NEW_WINDOW_EVENT = "menu://open-workspace-new-window";

function Shell() {
  const { status, workspace, createWorkspace, beginNewWorkspace, cancelNewWorkspace, chromeFaded, chromeTransitionMs } =
    useAppState();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Handed up from `Workspace` (a sibling below) once it's opened its own
  // `DendroidDocument`, so `SettingsPage`'s encryption panel can drive the
  // same live document — see `Workspace.tsx`'s `onDocumentReady` prop.
  const [crdt, setCrdt] = useState<DendroidDocument | null>(null);

  useEffect(() => {
    if (!hasTauriBridge()) return;
    let unlistenSettings: (() => void) | undefined;
    let unlistenNewWorkspace: (() => void) | undefined;
    let unlistenOpenWorkspace: (() => void) | undefined;
    let unlistenOpenWorkspaceNewWindow: (() => void) | undefined;

    // "Open Workspace…" skips WorkspaceOnboarding's provider/name steps —
    // it goes straight to a folder picker and adopts the chosen folder as
    // the (single, active — see `createWorkspace`) workspace, named after
    // itself, same as onboarding's default when no name is typed.
    async function openWorkspace() {
      const selected = await pickFolder();
      if (!selected) return;
      await createWorkspace({ name: folderNameFromPath(selected), sync: { type: "file", rootPath: selected } });
    }

    // "Open Workspace in New Window…" also picks a folder here, but hands
    // it to the Rust-side `open_workspace_window` command instead of
    // `createWorkspace` — that opens a whole separate window (with its own
    // document session; see `state::AppDocState`) rather than replacing
    // this window's workspace.
    async function openWorkspaceInNewWindow() {
      const selected = await pickFolder();
      if (!selected) return;
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_workspace_window", { root: selected });
    }

    void import("@tauri-apps/api/event").then(({ listen }) => {
      void listen(OPEN_SETTINGS_EVENT, () => setSettingsOpen(true)).then((fn) => {
        unlistenSettings = fn;
      });
      void listen(NEW_WORKSPACE_EVENT, () => beginNewWorkspace()).then((fn) => {
        unlistenNewWorkspace = fn;
      });
      void listen(OPEN_WORKSPACE_EVENT, () => void openWorkspace()).then((fn) => {
        unlistenOpenWorkspace = fn;
      });
      void listen(OPEN_WORKSPACE_NEW_WINDOW_EVENT, () => void openWorkspaceInNewWindow()).then((fn) => {
        unlistenOpenWorkspaceNewWindow = fn;
      });
    });
    return () => {
      unlistenSettings?.();
      unlistenNewWorkspace?.();
      unlistenOpenWorkspace?.();
      unlistenOpenWorkspaceNewWindow?.();
    };
  }, [createWorkspace, beginNewWorkspace]);

  if (status === "loading") {
    return (
      <div className="home">
        <span className="home__loading">Loading…</span>
      </div>
    );
  }

  if (status === "onboarding") {
    return <WorkspaceOnboarding onCancel={workspace ? cancelNewWorkspace : undefined} />;
  }

  // Only the "file" sync provider is implemented (see lib/syncProviders.ts)
  // — its rootPath is where the ledger lives, per whitepaper.md's Core
  // section: `{workspace_root}/ledger/{yyyy-mm-dd}.{session_id}.log`.
  const rootPath = workspace?.sync.type === "file" ? workspace.sync.rootPath : null;

  return (
    <>
      {rootPath ? (
        <Workspace rootPath={rootPath} onDocumentReady={setCrdt} />
      ) : (
        <main className="home">
          <span className="home__loading">This workspace's sync provider isn't supported yet.</span>
        </main>
      )}
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        aria-label="Open settings"
        className="settings-launcher"
        style={{
          // The other persistent piece of chrome outside the editor besides
          // the tree sidebar (see TreeView's `faded` prop) — whitepaper.md's
          // "other UI elements outside the Editor fade out" means this too,
          // not just the tree. Faded via AppState's `chromeFaded` rather
          // than a `Workspace`-local hook since this button lives in Shell,
          // a sibling of `Workspace`, not inside it.
          opacity: chromeFaded ? 0 : 1,
          pointerEvents: chromeFaded ? "none" : "auto",
          transition: `opacity ${chromeTransitionMs}ms cubic-bezier(0.2, 0, 0, 1)`,
        }}
      >
        <SettingsIcon size={16} />
      </button>
      {settingsOpen && <SettingsPage onClose={() => setSettingsOpen(false)} crdt={crdt} />}
    </>
  );
}

function App() {
  return (
    <AppStateProvider>
      <Shell />
    </AppStateProvider>
  );
}

export default App;
