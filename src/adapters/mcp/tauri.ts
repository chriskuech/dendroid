import type { McpAdapter } from "./types";

export function createTauriMcp(): McpAdapter {
  return {
    async applyMcpConfig(mcp) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("mcp_set_config", { enabled: mcp.enabled, host: mcp.host, port: mcp.port, disabledSkills: mcp.disabledSkills });
      } catch (err) {
        console.error("[mcp] failed to apply config", err);
      }
    },

    async listMcpSkills() {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        return await invoke("mcp_list_skills");
      } catch (err) {
        console.error("[mcp] failed to list skills", err);
        return [];
      }
    },
  };
}
