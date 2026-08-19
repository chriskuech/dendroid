// Covers TreeView's rendering + interaction contract, with particular
// attention to the two places it does its own bounded "expansion": folding
// heading rows in/out of view, and — the tree's own flavor of the app's
// "infinite expansion" risk — splicing a read-only preview of an expanded
// `@`-link's target subtree in place, which has to stay bounded even for a
// link that targets an ancestor of itself or the heading that encloses it.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TreeView } from "./TreeView";
import type { HeadingDto, LinkEntryDto, OutlineEntry } from "../../lib/crdt/outline";

function heading(id: string, depth: number, title: string, overrides: Partial<HeadingDto> = {}): OutlineEntry {
  return { kind: "heading", heading: { id, parent: null, index: 0, depth, level: depth + 1, title, ...overrides } };
}

function link(id: string, depth: number, targetId: string | null, overrides: Partial<LinkEntryDto> = {}): OutlineEntry {
  return { kind: "link", link: { id, targetId, staleTitle: null, parent: null, depth, ...overrides } };
}

function baseProps(overrides: Partial<React.ComponentProps<typeof TreeView>> = {}) {
  return {
    entries: [] as OutlineEntry[],
    collapsedIds: new Set<string>(),
    expandedLinkIds: new Set<string>(),
    previewDepth: 3,
    rootId: null,
    onSelectHeading: vi.fn(),
    onToggleCollapse: vi.fn(),
    onToggleLinkExpand: vi.fn(),
    onReroot: vi.fn(),
    ...overrides,
  };
}

describe("TreeView — headings", () => {
  it("shows the empty state when there are no headings", () => {
    render(<TreeView {...baseProps()} />);
    expect(screen.getByText(/no headings yet/i)).toBeInTheDocument();
  });

  it("renders every heading with its title", () => {
    const entries = [heading("a", 0, "Alpha"), heading("b", 0, "Beta")];
    render(<TreeView {...baseProps({ entries })} />);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("falls back to 'Untitled' for a heading with no title", () => {
    render(<TreeView {...baseProps({ entries: [heading("a", 0, "")] })} />);
    expect(screen.getByText("Untitled")).toBeInTheDocument();
  });

  it("hides descendants nested under a collapsed heading", () => {
    const entries = [heading("a", 0, "Alpha"), heading("a1", 1, "Alpha Child")];
    render(<TreeView {...baseProps({ entries, collapsedIds: new Set(["a"]) })} />);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByText("Alpha Child")).not.toBeInTheDocument();
  });

  it("clicking a heading's chevron toggles its collapse state, not selection", async () => {
    const user = userEvent.setup();
    const onToggleCollapse = vi.fn();
    const onSelectHeading = vi.fn();
    const entries = [heading("a", 0, "Alpha"), heading("a1", 1, "Child")];
    render(<TreeView {...baseProps({ entries, onToggleCollapse, onSelectHeading })} />);

    await user.click(document.querySelector(".tree-row__chevron")!);
    expect(onToggleCollapse).toHaveBeenCalledWith("a");
    expect(onSelectHeading).not.toHaveBeenCalled();
  });

  it("clicking a heading row (not its chevron) reroots it, not selects it", async () => {
    const user = userEvent.setup();
    const onReroot = vi.fn();
    const onSelectHeading = vi.fn();
    render(<TreeView {...baseProps({ entries: [heading("a", 0, "Alpha")], onReroot, onSelectHeading })} />);
    await user.click(screen.getByText("Alpha"));
    expect(onReroot).toHaveBeenCalledWith("a");
    expect(onSelectHeading).not.toHaveBeenCalled();
  });

  it("a leafless heading gets no chevron icon (nothing to fold)", () => {
    render(<TreeView {...baseProps({ entries: [heading("a", 0, "Alpha")] })} />);
    expect(document.querySelector(".tree-row__chevron--empty")).toBeInTheDocument();
  });

  it("marks the current root's row, not its descendants or siblings", () => {
    const entries = [heading("a", 0, "Alpha"), heading("a1", 1, "Child"), heading("b", 0, "Beta")];
    render(<TreeView {...baseProps({ entries, rootId: "a" })} />);
    const rows = document.querySelectorAll(".tree-row");
    expect(rows[0]).toHaveClass("tree-row--is-root");
    expect(rows[1]).not.toHaveClass("tree-row--is-root");
    expect(rows[2]).not.toHaveClass("tree-row--is-root");
  });

  it("clicking a descendant of the current root reroots to it, same as any other row", async () => {
    const user = userEvent.setup();
    const onReroot = vi.fn();
    const entries = [heading("a", 0, "Alpha"), heading("a1", 1, "Child")];
    render(<TreeView {...baseProps({ entries, rootId: "a", onReroot })} />);
    await user.click(screen.getByText("Child"));
    expect(onReroot).toHaveBeenCalledWith("a1");
  });

  it("boxes the current root's row together with its visible descendants, not its siblings", () => {
    const entries = [heading("a", 0, "Alpha"), heading("a1", 1, "Child"), heading("b", 0, "Beta")];
    render(<TreeView {...baseProps({ entries, rootId: "a" })} />);
    const rows = document.querySelectorAll(".tree-row");
    expect(rows[0]).toHaveClass("tree-row--root-group");
    expect(rows[0]).toHaveClass("tree-row--root-group-first");
    expect(rows[0]).not.toHaveClass("tree-row--root-group-last");
    expect(rows[1]).toHaveClass("tree-row--root-group");
    expect(rows[1]).toHaveClass("tree-row--root-group-last");
    expect(rows[2]).not.toHaveClass("tree-row--root-group");
  });

  it("with no explicit root, boxes the whole visible tree", () => {
    const entries = [heading("a", 0, "Alpha"), heading("b", 0, "Beta")];
    render(<TreeView {...baseProps({ entries, rootId: null })} />);
    const rows = document.querySelectorAll(".tree-row");
    expect(rows[0]).toHaveClass("tree-row--root-group-first");
    expect(rows[1]).toHaveClass("tree-row--root-group-last");
  });

  it("resolves heading levels relative to the current root", () => {
    const entries = [heading("a", 0, "Alpha", { level: 2 }), heading("a1", 1, "Child", { level: 3 })];
    render(<TreeView {...baseProps({ entries, rootId: "a" })} />);
    // Root row always reads as "#" regardless of its literal level.
    const rows = document.querySelectorAll(".tree-row__level");
    expect(rows[0].textContent).toBe("#");
    expect(rows[1].textContent).toBe("##");
  });
});

describe("TreeView — @-link rows and their preview expansion", () => {
  it("renders a link row with its target's title", () => {
    const entries = [heading("a", 0, "Alpha"), link("l1", 1, "a")];
    render(<TreeView {...baseProps({ entries })} />);
    expect(screen.getByText("@ Alpha")).toBeInTheDocument();
  });

  it("shows an orphaned link as 'Deleted heading' and gives it no chevron", () => {
    const entries = [link("l1", 0, null)];
    render(<TreeView {...baseProps({ entries })} />);
    expect(screen.getByText("@ Deleted heading")).toBeInTheDocument();
    expect(document.querySelector(".tree-row--link .tree-row__chevron--empty")).toBeInTheDocument();
  });

  it("expanding a link splices in its target's subtree, bounded by previewDepth", async () => {
    const user = userEvent.setup();
    const entries = [
      heading("a", 0, "Alpha"),
      heading("a1", 1, "Child"),
      heading("a1a", 2, "Grandchild"),
      heading("a1a1", 3, "Great-grandchild"),
      link("l1", 0, "a"),
    ];
    const onToggleLinkExpand = vi.fn();
    const { rerender } = render(<TreeView {...baseProps({ entries, onToggleLinkExpand, previewDepth: 2 })} />);

    // Not expanded yet: no preview rows at all (the headings themselves
    // still render as ordinary rows regardless — this only checks the
    // link's own spliced-in preview).
    expect(document.querySelectorAll(".tree-row--preview")).toHaveLength(0);

    await user.click(document.querySelector(".tree-row--link .tree-row__chevron")!);
    expect(onToggleLinkExpand).toHaveBeenCalledWith("l1");

    // Simulate the parent applying the toggle (mirrors real usage via
    // Workspace/the editor's own expand state).
    rerender(<TreeView {...baseProps({ entries, onToggleLinkExpand, previewDepth: 2, expandedLinkIds: new Set(["l1"]) })} />);

    const previewTitles = Array.from(document.querySelectorAll(".tree-row--preview .tree-row__title")).map((el) => el.textContent);
    // previewDepth: 2 levels past the target — the great-grandchild is
    // depth 3 past "a" and must be cut off, not shown.
    expect(previewTitles).toEqual(["Child", "Grandchild"]);
  });

  it("a link whose target is an ancestor of the heading enclosing it still renders a finite, non-recursive preview", () => {
    // "a1"'s own body contains a link back up to "a" — a back-edge in the
    // *link graph*, not the document tree, so nothing here should ever
    // walk in a circle: subtreeRows only reads forward through the real
    // outline (see outline.test.ts), and TreeView's preview rows are
    // static (no further expand affordance), so this can't cascade.
    const entries = [
      heading("a", 0, "Alpha"),
      heading("a1", 1, "Child"),
      link("l1", 2, "a"), // lives "inside" a1, points back at its ancestor a
    ];
    render(<TreeView {...baseProps({ entries, expandedLinkIds: new Set(["l1"]) })} />);

    // Renders once, promptly, and shows exactly "a"'s own subtree
    // (itself's row is dropped by TreeView's `.slice(1)`, leaving just its
    // one child) — not an unbounded or duplicated chain.
    const previewRows = document.querySelectorAll(".tree-row--preview");
    expect(previewRows).toHaveLength(1);
    expect(previewRows[0].textContent).toContain("Child");
  });

  it("a self-referencing link (its own enclosing heading as target) expands to one bounded preview, not an infinite one", () => {
    const entries = [heading("a", 0, "Alpha"), link("l1", 1, "a")];
    render(<TreeView {...baseProps({ entries, expandedLinkIds: new Set(["l1"]), previewDepth: 10 })} />);
    // "a" has no descendants of its own, so its preview (itself dropped)
    // is empty — the important thing is this renders at all and finishes.
    expect(document.querySelectorAll(".tree-row--preview")).toHaveLength(0);
    expect(document.querySelectorAll(".tree-row")).toHaveLength(2); // the heading row + the link row only
  });

  it("multiple independently-expanded links each get their own preview at the correct nesting depth", () => {
    const entries = [
      heading("a", 0, "Alpha"),
      heading("a1", 1, "AlphaChild"),
      heading("b", 0, "Beta"),
      heading("b1", 1, "BetaChild"),
      link("l1", 0, "a"),
      link("l2", 0, "b"),
    ];
    render(<TreeView {...baseProps({ entries, expandedLinkIds: new Set(["l1", "l2"]) })} />);
    // Both children already render as ordinary heading rows regardless of
    // the links (the outline shows every heading unconditionally) — what
    // this test actually checks is that *each* expanded link additionally
    // spliced in its own preview row, scoped to `.tree-row--preview` so it
    // isn't confused with the ordinary rows carrying the same title.
    const previewTitles = Array.from(document.querySelectorAll(".tree-row--preview .tree-row__title")).map((el) => el.textContent);
    expect(previewTitles).toEqual(["AlphaChild", "BetaChild"]);
  });
});
