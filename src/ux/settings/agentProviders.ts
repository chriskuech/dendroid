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
  /** Shown alongside "failed to launch" errors from this preset's `command`
   * (see `ux/agent/AgentPanel.tsx`'s `handleSend`) — the same install
   * command already mentioned in `description`, surfaced right when it's
   * actually needed instead of only in Settings' prose. `undefined` for
   * presets that don't spawn an external package (`none`, `custom` — a
   * custom command's install story is whatever the user picked, dendroid
   * has no preset instructions to offer). */
  installHint?: string;
}

// Presets for Settings' Agent section (see SettingsPage.tsx). Picking one
// fills in `AgentSettings.command`/`args`, which `adapters/acp`'s
// `startAgent` then spawns verbatim — same mechanism as typing them in
// under "Custom" by hand. Neither Claude Code nor Ollama speak ACP
// natively, so both presets actually point at a small adapter process
// sitting in front of them, not the model CLI/server itself.
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
      'Local models via OpenCode’s ACP adapter ("npm i -g opencode"), pointed at Ollama running on this machine. Pick the model inside OpenCode’s own config.',
    command: "opencode",
    args: "acp",
    editable: false,
    installHint: "npm i -g opencode",
  },
  claudeCode: {
    kind: "claudeCode",
    label: "Claude Code",
    description:
      'Anthropic’s Claude Code, via Zed’s ACP adapter ("npm i -g @zed-industries/claude-agent-acp"). Needs an ANTHROPIC_API_KEY in the environment, or an existing "claude login" session.',
    command: "claude-agent-acp",
    args: "",
    editable: false,
    installHint: "npm i -g @zed-industries/claude-agent-acp",
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
