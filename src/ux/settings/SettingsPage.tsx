import { useEffect, useRef, useState } from "react";
import { useAppState } from "../../lib/AppState";
import { AGENT_PROVIDERS } from "./agentProviders";
import type { DendroidDocument } from "../../lib/crdt/document";
import { useDialog } from "../../adapters/dialog/context";
import { SYNC_PROVIDERS } from "../../lib/syncProviders";
import {
  DEPTH_MIN,
  DEPTH_MAX,
  type Aesthetic,
  type AgentProvider,
  type ColorMode,
  type EditorMode,
  type FeatureSettings,
} from "../../lib/types";
import { CloseIcon } from "../../ui/icons";
import { Button } from "../../ui/Button";
import { Segmented } from "../../ui/Segmented";
import { Stepper } from "../../ui/Stepper";
import { Switch } from "../../ui/Switch";
import { EncryptionSection } from "./EncryptionSection";
import "./settings.css";

const SECTIONS = [
  { id: "appearance", label: "Appearance" },
  { id: "editor", label: "Editor" },
  { id: "features", label: "Features" },
  { id: "storage", label: "Storage" },
  { id: "mcp", label: "Local MCP" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/** Settings' "Features" switches, in the order the section (and the
 * sidebar rail — see `Sidebar.tsx`) lists them. `key` is the
 * `FeatureSettings` field it maps to; `hint` names the sidebar tab(s) it
 * adds, since that's the only thing most of these switches actually do. */
const FEATURE_META: { key: keyof FeatureSettings; label: string; hint: string }[] = [
  { key: "tree", label: "Tree", hint: "Adds the Tree tab to the left sidebar." },
  { key: "graph", label: "Graph", hint: "Adds the Graph tab to the left sidebar." },
  { key: "history", label: "History", hint: "Adds the History tab to the left sidebar." },
  { key: "databases", label: "Databases", hint: "Adds the Databases tab to the left sidebar." },
  { key: "research", label: "Research", hint: "Adds the Automations and Skills tabs to the left sidebar, and Chat to the right sidebar." },
];

const AESTHETIC_META: Record<Aesthetic, { label: string; swatches: string[] }> = {
  terminal: {
    label: "Terminal",
    swatches: ["#000000", "#8f8f8f", "#ededed", "#34e0a1"],
  },
  parchment: {
    label: "Parchment",
    swatches: ["#f6f1e7", "#14110d", "#ece4d6", "#d99a63"],
  },
};

export function SettingsPage({ onClose, crdt = null }: { onClose: () => void; crdt?: DendroidDocument | null }) {
  const { workspace, settings, updateSettings, updateSyncConfig } = useAppState();
  const dialog = useDialog();
  const [active, setActive] = useState<SectionId>("appearance");
  const [copied, setCopied] = useState(false);
  const sectionRefs = useRef<Partial<Record<SectionId, HTMLDivElement>>>({});

  function selectAgentProvider(provider: AgentProvider) {
    const meta = AGENT_PROVIDERS[provider];
    updateSettings({
      agent: {
        provider,
        // Editable ("custom") keeps whatever was already typed in;
        // everything else snaps command/args to its own preset.
        command: meta.editable ? settings.agent.command : meta.command,
        args: meta.editable ? settings.agent.args : meta.args,
      },
    });
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length > 0) {
          const topMost = visible.reduce((a, b) => (a.boundingClientRect.top < b.boundingClientRect.top ? a : b));
          setActive(topMost.target.id as SectionId);
        }
      },
      { rootMargin: "-10% 0px -70% 0px", threshold: 0 },
    );
    Object.values(sectionRefs.current).forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, []);

  function scrollTo(id: SectionId) {
    sectionRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActive(id);
  }

  async function handleChangeSyncPath() {
    if (!workspace || workspace.sync.type !== "file") return;
    const selected = await dialog.pickFolder(workspace.sync.rootPath);
    if (selected) updateSyncConfig({ type: "file", rootPath: selected });
  }

  const mcpConfig = `{ "dendroid": { "url": "http://${settings.mcp.host}:${settings.mcp.port}/mcp" } }`;

  async function handleCopyConfig() {
    try {
      await navigator.clipboard.writeText(mcpConfig);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard permission denied — nothing more we can do here
    }
  }

  return (
    <div className="settings">
      <nav className="settings__nav">
        <span className="settings__nav-label">Settings</span>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`settings__nav-item${active === s.id ? " settings__nav-item--active" : ""}`}
            onClick={() => scrollTo(s.id)}
          >
            {s.label}
          </button>
        ))}
        <div className="settings__nav-footer">
          {workspace && <span className="settings__nav-workspace">{workspace.name}</span>}
          <span className="settings__nav-version">v0.0.0</span>
        </div>
      </nav>

      <main className="settings__main">
        <div className="settings__header">
          <span className="settings__header-title">Settings</span>
          <button type="button" className="settings__header-close" onClick={onClose} aria-label="Close settings">
            <CloseIcon size={16} />
          </button>
          <span className="settings__header-esc">esc</span>
        </div>

        <div
          id="appearance"
          className="settings__section"
          ref={(el) => {
            if (el) sectionRefs.current.appearance = el;
          }}
        >
          <span className="settings__section-title">Appearance</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <span className="settings__row-label" style={{ width: "auto" }}>
              Aesthetic
            </span>
            <div className="card-grid">
              {(Object.keys(AESTHETIC_META) as Aesthetic[]).map((aesthetic) => {
                const meta = AESTHETIC_META[aesthetic];
                const selected = settings.aesthetic === aesthetic;
                return (
                  <button
                    key={aesthetic}
                    type="button"
                    className={`card${selected ? " card--selected" : ""}`}
                    onClick={() => updateSettings({ aesthetic })}
                  >
                    <div className="card__head">
                      <span className="card__dot" />
                      <span className="card__title">{meta.label}</span>
                    </div>
                    <div className="card__swatches">
                      {meta.swatches.map((color) => (
                        <span key={color} className="card__swatch" style={{ background: color }} />
                      ))}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="settings__row">
            <span className="settings__row-label">Color</span>
            <Segmented<ColorMode>
              value={settings.colorMode}
              onChange={(colorMode) => updateSettings({ colorMode })}
              options={[
                { value: "dark", label: "Dark" },
                { value: "light", label: "Light" },
                { value: "system", label: "System" },
              ]}
            />
          </div>
        </div>

        <div
          id="editor"
          className="settings__section"
          ref={(el) => {
            if (el) sectionRefs.current.editor = el;
          }}
        >
          <span className="settings__section-title">Editor</span>
          <div className="settings__row">
            <span className="settings__row-label">Mode</span>
            <Segmented<EditorMode>
              value={settings.editorMode}
              onChange={(editorMode) => updateSettings({ editorMode })}
              options={[
                { value: "zen", label: "Zen" },
                { value: "overlay", label: "Overlay" },
              ]}
            />
            <span className="settings__row-hint">
              {settings.editorMode === "zen"
                ? "UI fades once the cursor is in the editor"
                : "UI elements stay visible"}
            </span>
          </div>
          <div className="settings__row">
            <span className="settings__row-label">Descendant depth</span>
            <Stepper
              value={settings.descendantDepth}
              min={DEPTH_MIN}
              max={DEPTH_MAX}
              onChange={(descendantDepth) => updateSettings({ descendantDepth })}
            />
            <span className="settings__row-hint">levels rendered below the root</span>
          </div>
          <div className="settings__row">
            <span className="settings__row-label">Use system font</span>
            <Switch checked={settings.useSystemFont} onChange={(useSystemFont) => updateSettings({ useSystemFont })} />
            <span className="settings__row-hint">
              {settings.useSystemFont ? "Editor uses the OS UI font" : "Editor uses Public Sans"}
            </span>
          </div>
          <div className="settings__row">
            <span className="settings__row-label">Aural feedback</span>
            <Switch checked={settings.auralFeedback} onChange={(auralFeedback) => updateSettings({ auralFeedback })} />
            <span className="settings__row-hint">Soft typewriter key sound on every keypress</span>
          </div>
        </div>

        <div
          id="features"
          className="settings__section"
          ref={(el) => {
            if (el) sectionRefs.current.features = el;
          }}
        >
          <span className="settings__section-title">Features</span>
          {FEATURE_META.map((feature) => (
            <div key={feature.key} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="settings__row">
                <span className="settings__row-label">{feature.label}</span>
                <Switch
                  checked={settings.features[feature.key]}
                  onChange={(value) => updateSettings({ features: { ...settings.features, [feature.key]: value } })}
                />
                <span className="settings__row-hint">{feature.hint}</span>
              </div>

              {feature.key === "research" && settings.features.research && (
                <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingLeft: 16 }}>
                  <div className="settings__row">
                    <span className="settings__row-label">Provider</span>
                    <Segmented<AgentProvider>
                      value={settings.agent.provider}
                      onChange={selectAgentProvider}
                      options={(Object.keys(AGENT_PROVIDERS) as AgentProvider[]).map((provider) => ({
                        value: provider,
                        label: AGENT_PROVIDERS[provider].label,
                      }))}
                    />
                  </div>
                  <span className="settings__row-hint">{AGENT_PROVIDERS[settings.agent.provider].description}</span>

                  {settings.agent.provider === "custom" && (
                    <>
                      <div className="field">
                        <span className="field__label">Command</span>
                        <input
                          className="field-input"
                          value={settings.agent.command}
                          placeholder="e.g. claude-agent-acp"
                          onChange={(e) => updateSettings({ agent: { ...settings.agent, command: e.target.value } })}
                        />
                      </div>
                      <div className="field">
                        <span className="field__label">Arguments</span>
                        <input
                          className="field-input"
                          value={settings.agent.args}
                          placeholder="space-separated, optional"
                          onChange={(e) => updateSettings({ agent: { ...settings.agent, args: e.target.value } })}
                        />
                      </div>
                    </>
                  )}
                  <span className="settings__block-hint">
                    Any Agent Client Protocol (ACP) agent — launched over stdio the first time the chat drawer connects.
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>

        <div
          id="storage"
          className="settings__section"
          ref={(el) => {
            if (el) sectionRefs.current.storage = el;
          }}
        >
          <span className="settings__section-title">Storage</span>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <span className="settings__subsection-title">Folder</span>
            <div className="panel">
              {workspace?.sync.type === "file" && (
                <>
                  <div className="panel-row">
                    <span className="panel-row__dot panel-row__dot--on" />
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span className="panel-row__title">File</span>
                      <span className="panel-row__sub">Stored locally on disk. Store in a cloud-synced folder for free multi-device sync.</span>
                    </div>
                    <span className="panel-row__status">connected</span>
                  </div>
                  <div className="panel-row" style={{ background: "var(--surface)" }}>
                    <span className="panel-row__dot" style={{ border: "none" }} />
                    <input
                      type="text"
                      value={workspace.sync.rootPath}
                      readOnly
                      className="field-input"
                      style={{ flex: 1, background: "var(--bg)" }}
                    />
                    <Button variant="secondary" onClick={handleChangeSyncPath}>
                      Choose…
                    </Button>
                  </div>
                </>
              )}
              {SYNC_PROVIDERS.filter((p) => !p.available).map((provider) => (
                <div className="panel-row" key={provider.kind}>
                  <span className="panel-row__dot" />
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span className="panel-row__title panel-row__title--muted">{provider.label}</span>
                    <span className="panel-row__sub" style={{ color: "var(--line-strong)" }}>
                      {provider.description}
                    </span>
                  </div>
                  <span className="badge" style={{ marginLeft: "auto" }}>
                    Coming soon
                  </span>
                </div>
              ))}
            </div>
            <span className="settings__block-hint">Providers are mutually exclusive.</span>
          </div>

          <EncryptionSection crdt={crdt} />

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <span className="settings__subsection-title">Materialize</span>
            <div className="settings__row">
              <span className="settings__row-label">DBs</span>
              <Switch
                checked={settings.materialize.dbs}
                onChange={(dbs) => updateSettings({ materialize: { ...settings.materialize, dbs } })}
              />
              <span className="settings__row-hint">Additionally saves databases as plain SQLite files, debounced.</span>
            </div>
            <div className="settings__row">
              <span className="settings__row-label">Markdown</span>
              <Switch
                checked={settings.materialize.markdown}
                onChange={(markdown) => updateSettings({ materialize: { ...settings.materialize, markdown } })}
              />
              <span className="settings__row-hint">Additionally saves the markdown tree as a plain markdown file, debounced.</span>
            </div>
            <span className="settings__block-hint">
              Both are derived, disposable projections of the ledger for tools outside dendroid — the ledger stays the source of truth.
            </span>
          </div>
        </div>

        <div
          id="mcp"
          className="settings__section"
          ref={(el) => {
            if (el) sectionRefs.current.mcp = el;
          }}
        >
          <span className="settings__section-title">Local MCP</span>
          <div className="settings__row">
            <span className="settings__row-label">Server</span>
            <Switch checked={settings.mcp.enabled} onChange={(enabled) => updateSettings({ mcp: { ...settings.mcp, enabled } })} />
            <span className="settings__row-hint">{settings.mcp.enabled ? "enabled" : "disabled"}</span>
          </div>
          <div style={{ display: "flex", gap: 12, maxWidth: 640 }}>
            <div className="field" style={{ flex: 1 }}>
              <span className="field__label">Host</span>
              <input className="field-input" value={settings.mcp.host} readOnly />
            </div>
            <div className="field" style={{ width: 140 }}>
              <span className="field__label">Port</span>
              <input className="field-input" value={settings.mcp.port} readOnly />
            </div>
          </div>
          <div className="field">
            <span className="field__label">Client config</span>
            <div className="settings__code-row">
              <pre className="settings__code">{mcpConfig}</pre>
              <Button variant="secondary" onClick={handleCopyConfig} style={{ flex: "none" }}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
