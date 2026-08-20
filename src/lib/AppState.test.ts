import { describe, expect, it } from "vitest";
import { normalizeLegacyWorkspace } from "./AppState";
import type { Workspace } from "./types";

// Regression test for the "Flatten Storage Folder" shape change: a
// `settings.json` saved before it persists `Workspace.sync.rootPath`
// instead of a top-level `rootPath`. Without migrating that on load,
// `workspace.rootPath` comes back `undefined` and every `workspace_open`
// IPC call fails outright ("missing required key root") — the app's whole
// error screen, for anyone who already had a workspace before upgrading.
describe("normalizeLegacyWorkspace", () => {
  it("passes null through unchanged", () => {
    expect(normalizeLegacyWorkspace(null)).toBeNull();
  });

  it("leaves an already-current workspace unchanged (same reference)", () => {
    const ws: Workspace = { id: "1", name: "notes", rootPath: "/home/me/notes", createdAt: "2026-01-01T00:00:00Z" };
    expect(normalizeLegacyWorkspace(ws)).toBe(ws);
  });

  it("lifts a legacy sync.rootPath up to the top level", () => {
    const legacy = {
      id: "1",
      name: "notes",
      sync: { type: "file", rootPath: "/home/me/notes" },
      createdAt: "2026-01-01T00:00:00Z",
    } as unknown as Workspace;

    expect(normalizeLegacyWorkspace(legacy)).toEqual({
      id: "1",
      name: "notes",
      rootPath: "/home/me/notes",
      createdAt: "2026-01-01T00:00:00Z",
    });
  });

  it("returns the input unchanged if neither rootPath nor sync.rootPath is present", () => {
    const empty = { id: "1", name: "notes", createdAt: "2026-01-01T00:00:00Z" } as unknown as Workspace;
    expect(normalizeLegacyWorkspace(empty)).toBe(empty);
  });
});
