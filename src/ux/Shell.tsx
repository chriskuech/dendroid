import { useEffect, useState } from "react";
import { useAppState } from "../lib/AppState";
import type { DendroidDocument } from "../lib/crdt/document";
import { useDialog } from "../adapters/dialog/context";
import { hasTauriBridge } from "../adapters/detectPlatform";
import { folderNameFromPath } from "../lib/path";
import { WorkspaceOnboarding } from "./onboarding/WorkspaceOnboarding";
import { SettingsPage } from "./settings/SettingsPage";
import { Workspace } from "./workspace/Workspace";

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

export function Shell() {
  const { status, workspace, createWorkspace, beginNewWorkspace, cancelNewWorkspace } = useAppState();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Handed up from `Workspace` (a sibling below) once it's opened its own
  // `DendroidDocument`, so `SettingsPage`'s encryption panel can drive the
  // same live document — see `Workspace.tsx`'s `onDocumentReady` prop.
  const [crdt, setCrdt] = useState<DendroidDocument | null>(null);
  const dialog = useDialog();

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
      const selected = await dialog.pickFolder();
      if (!selected) return;
      await createWorkspace({ name: folderNameFromPath(selected), rootPath: selected });
    }

    // "Open Workspace in New Window…" also picks a folder here, but hands
    // it to the Rust-side `open_workspace_window` command instead of
    // `createWorkspace` — that opens a whole separate window (with its own
    // document session; see `state::AppDocState`) rather than replacing
    // this window's workspace.
    async function openWorkspaceInNewWindow() {
      const selected = await dialog.pickFolder();
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
  }, [createWorkspace, beginNewWorkspace, dialog]);

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

  return (
    <>
      {workspace && <Workspace rootPath={workspace.rootPath} onDocumentReady={setCrdt} onOpenSettings={() => setSettingsOpen(true)} />}
      {settingsOpen && <SettingsPage onClose={() => setSettingsOpen(false)} crdt={crdt} />}
    </>
  );
}
