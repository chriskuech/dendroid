import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DEFAULT_SETTINGS, type AgentSettings, type AppSettings, type FeatureSettings, type Workspace } from "./types";
import { NARROW_QUERY } from "./layout";
import { useMaterialize } from "../adapters/materialize/context";
import { useMcp } from "../adapters/mcp/context";
import { useSettingsStore } from "../adapters/settingsStore/context";
import { folderNameFromPath } from "./path";
import { useMediaQuery } from "./useMediaQuery";
import { useTheme } from "./useTheme";
import { useZenChrome } from "./useZenChrome";
import { useZenCursor } from "./useZenCursor";

declare global {
  interface Window {
    /** Seeded by the Rust side's `open_workspace_window` command
     * (`src-tauri/src/commands.rs`, via `initialization_script`) on a
     * window opened from "File > Open Workspace in New Window" — the
     * workspace root this particular window should boot into, independent
     * of (and never persisted over) the single workspace every other
     * window remembers via `settingsStore`. */
    __DENDROID_INITIAL_WORKSPACE_ROOT__?: string;
  }
}

type Status = "loading" | "onboarding" | "ready";

interface AppStateValue {
  status: Status;
  workspace: Workspace | null;
  settings: AppSettings;
  resolvedMode: "dark" | "light";
  /** True once the viewport is narrow enough for the tree to become a
   * drawer instead of a sidebar (see `lib/layout.ts`). Lifted up here
   * (rather than each consumer calling `useMediaQuery` itself) so it can
   * also gate the narrow topbar's chrome-fade wiring, alongside
   * `Workspace`'s own layout branch. */
  isNarrow: boolean;
  /** Whether the editor currently has focus — set by `Workspace` via
   * `setEditorFocused`, read by `useZenChrome` below. Lives here rather
   * than as `Workspace`-local state because zen mode needs to fade chrome
   * that isn't inside `Workspace` at all (the settings launcher in
   * `App.tsx`), so both need the same signal. */
  editorFocused: boolean;
  setEditorFocused: (focused: boolean) => void;
  /** Whether zen mode currently has the chrome faded, and the transition
   * duration to pair with it — see `useZenChrome`. Every piece of UI
   * outside the editor (tree sidebar, settings launcher, …) reads this
   * one value rather than each running its own idle timer. */
  chromeFaded: boolean;
  chromeTransitionMs: number;
  createWorkspace: (input: { name: string; rootPath: string }) => Promise<void>;
  /** Drops back into the onboarding flow to create a workspace that
   * replaces the current one (only one workspace is active at a time —
   * see `createWorkspace`). Driven by the "File > New Workspace" menu
   * item; see `OPEN_NEW_WORKSPACE_EVENT` in App.tsx. */
  beginNewWorkspace: () => void;
  /** Backs out of `beginNewWorkspace` without creating anything, returning
   * to the current workspace. Only valid once one already exists. */
  cancelNewWorkspace: () => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
  /** Changes the active workspace's folder — Settings' Storage > Folder
   * "Choose…" button. */
  updateWorkspaceRootPath: (rootPath: string) => void;
}

const AppStateContext = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const settingsStore = useSettingsStore();
  const mcp = useMcp();
  const materialize = useMaterialize();
  const [status, setStatus] = useState<Status>("loading");
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [editorFocused, setEditorFocused] = useState(false);
  // Fixed for this window's whole lifetime (a window doesn't change which
  // one it is), so a ref rather than state — read by `createWorkspace`/
  // `updateWorkspaceRootPath` below to skip persisting into the single
  // shared `settingsStore` workspace that every *other* window reads on
  // launch. Without this, e.g. picking a new folder in a secondary
  // window's Settings would silently steal "the" workspace out from under
  // the window that opened it.
  const isSecondaryWindow = useRef(typeof window !== "undefined" && !!window.__DENDROID_INITIAL_WORKSPACE_ROOT__);
  const isNarrow = useMediaQuery(NARROW_QUERY);
  // Not gated on `isNarrow` — the narrow topbar (hamburger + breadcrumb)
  // is chrome outside the editor same as the sidebar and settings launcher
  // are, so it fades right along with them (see Workspace.tsx's topbar).
  const zenActive = settings.editorMode === "zen";
  const { faded: chromeFaded, transitionMs: chromeTransitionMs } = useZenChrome(zenActive, editorFocused);

  // The pointer itself recedes in zen mode too, same idle countdown as the
  // sidebar and settings launcher (`useZenChrome`'s `IDLE_MS`) — but
  // *not* the same wake condition. `useZenChrome` ignores pointer
  // movement that stays inside the editor (writing shouldn't keep
  // flickering the chrome back in); the cursor has no such exception, so
  // it gets its own hook rather than reusing `chromeFaded`. See
  // `useZenCursor`'s comment. No transition either way — `cursor` isn't
  // an animatable CSS property, so this is a hard toggle.
  const cursorHidden = useZenCursor(zenActive, editorFocused);
  useEffect(() => {
    document.body.style.cursor = cursorHidden ? "none" : "";
    return () => {
      document.body.style.cursor = "";
    };
  }, [cursorHidden]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // A window opened via "File > Open Workspace in New Window" gets its
      // workspace seeded directly rather than through the shared,
      // single-workspace `settingsStore` — see `__DENDROID_INITIAL_WORKSPACE_ROOT__`.
      const initialRoot = window.__DENDROID_INITIAL_WORKSPACE_ROOT__;
      const [ws, savedSettings] = await Promise.all([
        initialRoot ? Promise.resolve(null) : settingsStore.loadWorkspace(),
        settingsStore.loadAppSettings(),
      ]);
      if (cancelled) return;
      // A shallow `{ ...DEFAULT_SETTINGS, ...savedSettings }` would let a
      // persisted `mcp`/`agent` object from before one of their fields
      // existed (e.g. `mcp.disabledSkills`, added by the Skills settings
      // section) wholesale replace the default and silently drop it —
      // `undefined.includes(...)` in SettingsPage's Skills list, with no
      // error boundary to catch it, so merge those nested objects a level
      // deeper too.
      if (savedSettings) {
        // Pre-provider-picker installs persisted `agent.command`/`args`
        // with no `provider` field at all. Merging those over
        // DEFAULT_SETTINGS.agent (provider: "none") would keep the old
        // command around but flip the picker to "None", which hides it in
        // Settings and reads as agent chat having been turned off — so
        // anyone with a real command already saved is a "Custom" agent,
        // not a fresh, unconfigured one.
        const savedAgent = savedSettings.agent;
        // Widened to `Partial` for this check alone: `AgentSettings` itself
        // says `provider` always exists, so without this TS narrows the
        // "old shape" branch below to `never` — the whole point here is
        // handling saved JSON that predates the field and doesn't actually
        // conform.
        const legacyAgent = savedAgent as Partial<AgentSettings> | undefined;
        const agent = { ...DEFAULT_SETTINGS.agent, ...savedAgent };
        if (legacyAgent && !("provider" in legacyAgent) && legacyAgent.command) {
          agent.provider = "custom";
        }
        // Same "old shape predates the field" story as `agent` above:
        // `features` (and its `research` switch) didn't exist before this
        // section shipped, so a save from before then has no opinion on
        // it. Rather than defaulting it off and silently hiding an agent
        // someone already had configured (pre-`AgentProvider` saves aside,
        // covered by the `agent.provider` migration just above), infer it
        // from whether an agent was actually set up.
        const legacyFeatures = savedSettings.features as Partial<FeatureSettings> | undefined;
        const features = { ...DEFAULT_SETTINGS.features, ...savedSettings.features };
        if (!legacyFeatures || !("research" in legacyFeatures)) {
          features.research = agent.provider !== "none";
        }
        setSettings({
          ...DEFAULT_SETTINGS,
          ...savedSettings,
          mcp: { ...DEFAULT_SETTINGS.mcp, ...savedSettings.mcp },
          agent,
          features,
          materialize: { ...DEFAULT_SETTINGS.materialize, ...savedSettings.materialize },
        });
      }
      if (initialRoot) {
        setWorkspace({
          id: crypto.randomUUID(),
          name: folderNameFromPath(initialRoot),
          rootPath: initialRoot,
          createdAt: new Date().toISOString(),
        });
        setStatus("ready");
      } else {
        setWorkspace(ws);
        setStatus(ws ? "ready" : "onboarding");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settingsStore]);

  const resolvedMode = useTheme(settings.aesthetic, settings.colorMode, settings.useSystemFont);

  // Keeps the in-process local MCP server (src-tauri's `mcp` module) in
  // sync with Settings' "Local MCP" section whenever it changes. This
  // covers toggling it on/off (or changing host/port) once a workspace is
  // already open; a workspace opening for the first time with it already
  // enabled from a previous session is covered separately, by
  // `Workspace.tsx`'s own effect once its `workspace_open` call has
  // actually completed — `status` here flips to "ready" as soon as *which*
  // workspace to open is known, not once it's actually open, so relying on
  // this effect alone would race ahead of the Rust side having a session
  // to serve yet.
  useEffect(() => {
    if (status !== "ready") return;
    void mcp.applyMcpConfig(settings.mcp);
  }, [status, settings.mcp, mcp]);

  // Same "cover every change, not just the first" story as the effect
  // above — see `Workspace.tsx`'s own materialize effect for the cold-start
  // half (an already-open workspace when this fires for the first time).
  useEffect(() => {
    if (status !== "ready") return;
    void materialize.applyMaterializeConfig(settings.materialize);
  }, [status, settings.materialize, materialize]);

  const createWorkspace = useCallback(
    async (input: { name: string; rootPath: string }) => {
      const ws: Workspace = {
        id: crypto.randomUUID(),
        name: input.name,
        rootPath: input.rootPath,
        createdAt: new Date().toISOString(),
      };
      if (!isSecondaryWindow.current) await settingsStore.saveWorkspace(ws);
      setWorkspace(ws);
      setStatus("ready");
    },
    [settingsStore],
  );

  const beginNewWorkspace = useCallback(() => {
    setStatus("onboarding");
  }, []);

  const cancelNewWorkspace = useCallback(() => {
    setStatus((prev) => (prev === "onboarding" && workspace ? "ready" : prev));
  }, [workspace]);

  const updateSettings = useCallback(
    (patch: Partial<AppSettings>) => {
      setSettings((prev) => {
        const next = { ...prev, ...patch };
        void settingsStore.saveAppSettings(next);
        return next;
      });
    },
    [settingsStore],
  );

  const updateWorkspaceRootPath = useCallback(
    (rootPath: string) => {
      setWorkspace((prev) => {
        if (!prev) return prev;
        const next = { ...prev, rootPath };
        if (!isSecondaryWindow.current) void settingsStore.saveWorkspace(next);
        return next;
      });
    },
    [settingsStore],
  );

  const value = useMemo<AppStateValue>(
    () => ({
      status,
      workspace,
      settings,
      resolvedMode,
      isNarrow,
      editorFocused,
      setEditorFocused,
      chromeFaded,
      chromeTransitionMs,
      createWorkspace,
      beginNewWorkspace,
      cancelNewWorkspace,
      updateSettings,
      updateWorkspaceRootPath,
    }),
    [
      status,
      workspace,
      settings,
      resolvedMode,
      isNarrow,
      editorFocused,
      chromeFaded,
      chromeTransitionMs,
      createWorkspace,
      beginNewWorkspace,
      cancelNewWorkspace,
      updateSettings,
      updateWorkspaceRootPath,
    ],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState must be used within AppStateProvider");
  return ctx;
}
