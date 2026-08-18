import type { McpAdapter } from "./types";

/** No process to spawn a local MCP server in outside Tauri. */
export function createUnavailableMcp(): McpAdapter {
  return {
    async applyMcpConfig() {},
    async listMcpSkills() {
      return [];
    },
  };
}
