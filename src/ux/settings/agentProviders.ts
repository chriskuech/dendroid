import type { AgentProvider } from "../../lib/types";

export interface AgentProviderMeta {
  kind: AgentProvider;
  label: string;
  description: string;
  /** Preset `command`/`args` this provider runs. Only actually applied when
   * `editable` is false — picking an editable provider ("custom") leaves
   * whatever `AgentSettings.command`/`args` already held alone, so the
   * user's typed-in values survive switching away and back. */
  command: string;
  args: string;
  /** Whether Settings' Command/Arguments fields are user-editable for this
   * provider, vs. locked (read-only) to the preset above. */
  editable: boolean;
  /** Shown alongside a "failed to launch" error for this preset's `command`
   * (see `ux/agent/AgentPanel.tsx`'s `handleSend`) — every preset below
   * runs through `npx`, so that only happens when `npx` itself isn't on
   * `PATH`, i.e. Node.js isn't installed. `undefined` for presets that
   * don't spawn anything through `npx` (`none`, `custom` — a custom
   * command's requirements are whatever the user picked). */
  installHint?: string;
}

// Presets for Settings' Agent section (see SettingsPage.tsx). Picking one
// fills in `AgentSettings.command`/`args`, which `adapters/acp`'s
// `startAgent` then spawns verbatim — same mechanism as typing them in
// under "Custom" by hand. Neither Claude Code nor Ollama speak ACP
// natively, so both presets actually point at a small adapter package
// sitting in front of them, not the model CLI/server itself — and neither
// requires the user to install that adapter themselves: both run it via
// `npx -y <package>`, which fetches and caches the package on first launch
// if it isn't already present, the same way `npx`-fronted MCP server
// configs commonly do. The only prerequisite left is Node.js/npm itself.
const NODE_INSTALL_HINT = "requires Node.js (npx) on your PATH — install it from https://nodejs.org";

export const AGENT_PROVIDERS: Record<AgentProvider, AgentProviderMeta> = {
  none: {
    kind: "none",
    label: "None",
    description: "Agent chat is turned off.",
    command: "",
    args: "",
    editable: false,
  },
  ollama: {
    kind: "ollama",
    label: "Ollama",
    description:
      "Local models via OpenCode’s ACP adapter, pointed at Ollama running on this machine. Pick the model inside OpenCode’s own config. Fetched automatically via npx on first launch — no separate install step.",
    command: "npx",
    args: "-y opencode acp",
    editable: false,
    installHint: NODE_INSTALL_HINT,
  },
  claudeCode: {
    kind: "claudeCode",
    label: "Claude Code",
    description:
      'Anthropic’s Claude Code, via Zed’s ACP adapter. Needs an ANTHROPIC_API_KEY in the environment, or an existing "claude login" session. Fetched automatically via npx on first launch — no separate install step.',
    command: "npx",
    args: "-y @zed-industries/claude-agent-acp",
    editable: false,
    installHint: NODE_INSTALL_HINT,
  },
  custom: {
    kind: "custom",
    label: "Custom",
    description: "Add settings directly — any Agent Client Protocol (ACP) agent, by its own command and arguments.",
    command: "",
    args: "",
    editable: true,
  },
};
