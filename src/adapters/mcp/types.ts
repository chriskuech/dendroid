import type { McpSettings } from "../../lib/types";

export interface McpAdapter {
  /** Starts/stops/restarts the in-process local MCP server (`src-tauri`'s
   * `mcp` module) to match Settings' "Local MCP" section. No-op outside
   * Tauri (see `unavailable.ts`) — the web/wasm preview build has nothing
   * to spawn a server process in. */
  applyMcpConfig(mcp: McpSettings): Promise<void>;

  /** The full skill catalog, regardless of "Local MCP" being enabled or
   * which are currently in `McpSettings.disabledSkills` — Settings'
   * "Skills" section uses this to render every skill with a view of its
   * description and an enable/disable switch, browsable even before the
   * server's ever been turned on. */
  listMcpSkills(): Promise<McpSkill[]>;
}

/** One tool the local MCP server (`src-mcp`) can expose — a "skill" in
 * Settings' terms. See `mcp_list_skills` (`src-tauri/src/mcp.rs`). */
export interface McpSkill {
  name: string;
  description: string;
}
