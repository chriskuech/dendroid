// Starts/stops/restarts the in-process local MCP server (`src-tauri`'s
// `mcp` module) to match Settings' "Local MCP" section — that UI has
// existed since before there was a server behind it (see
// `SettingsPage.tsx`); this is what actually wires the toggle up.
//
// A no-op outside Tauri (the web/wasm preview build has nothing to spawn a
// server process in) — same guard `dialog.ts`'s `pickFolder` uses.

import type { McpSettings } from "./types";

function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function applyMcpConfig(mcp: McpSettings): Promise<void> {
  if (!hasTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("mcp_set_config", { enabled: mcp.enabled, host: mcp.host, port: mcp.port });
  } catch (err) {
    console.error("[mcp] failed to apply config", err);
  }
}
