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
}

// Presets for Settings' Agent section (see SettingsPage.tsx). Picking one
// fills in `AgentSettings.command`/`args`, which `adapters/acp`'s
// `startAgent` then spawns verbatim — same mechanism as typing them in
// under "Custom" by hand. Neither Claude Code nor Ollama speak ACP
// natively, so both presets actually point at a small adapter package
// sitting in front of them, not the model CLI/server itself.
//
// Both use `command: "bunx"` — a sentinel `src-tauri/src/acp.rs`'s
// `acp_start` recognizes and swaps for the app's own cached, auto-
// downloaded Bun runtime (`src-tauri/src/agent_runtime.rs`), invoked as
// `bun x -y <args>`: an `npx`-alike that fetches the named npm package on
// first use and caches it. That's what makes these two presets work with
// *nothing* pre-installed — no Node.js, no npm, no manual `npm i -g`
// step — the app provisions its own runtime for them the first time
// they're actually used. A "custom" command can opt into the same
// mechanism by typing "bunx" itself.
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
      "Local models via OpenCode’s ACP adapter, pointed at Ollama running on this machine. Pick the model inside OpenCode’s own config. Nothing to install — dendroid fetches it automatically on first use.",
    command: "bunx",
    args: "opencode-ai acp",
    editable: false,
  },
  claudeCode: {
    kind: "claudeCode",
    label: "Claude Code",
    description:
      'Anthropic’s Claude Code, via Zed’s ACP adapter. Needs an ANTHROPIC_API_KEY in the environment, or an existing "claude login" session. Nothing to install — dendroid fetches it automatically on first use.',
    command: "bunx",
    args: "@agentclientprotocol/claude-agent-acp",
    editable: false,
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
