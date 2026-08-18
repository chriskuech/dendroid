import type { AcpAdapter, AcpBridgeEvent } from "./types";

function splitArgs(args: string): string[] {
  return args.split(/\s+/).filter(Boolean);
}

export function createTauriAcp(): AcpAdapter {
  return {
    async startAgent(threadId, cwd, agent, mcpUrl) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("acp_start", { threadId, command: agent.command, args: splitArgs(agent.args), cwd, mcpUrl });
    },

    async stopAgent(threadId) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("acp_stop", { threadId });
    },

    async sendPrompt(threadId, text) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke("acp_send_prompt", { threadId, text });
    },

    async cancelPrompt(threadId) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("acp_cancel", { threadId });
    },

    async respondPermission(threadId, requestId, outcome) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("acp_respond_permission", { threadId, requestId, outcome });
    },

    onAgentEvent(handler) {
      let unlisten: (() => void) | undefined;
      let cancelled = false;
      void import("@tauri-apps/api/event").then(({ listen }) => {
        if (cancelled) return;
        void listen<AcpBridgeEvent>("acp://event", (e) => handler(e.payload)).then((fn) => {
          if (cancelled) fn();
          else unlisten = fn;
        });
      });
      return () => {
        cancelled = true;
        unlisten?.();
      };
    },
  };
}
