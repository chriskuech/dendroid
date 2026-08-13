// Covers the rail-driven view switch itself (Sidebar's own job) — TreeView
// and MindMapView each have their own dedicated suites for what they render
// once selected.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./Sidebar";
import type { OutlineEntry } from "../../lib/crdt/outline";

function heading(id: string, title: string): OutlineEntry {
  return { kind: "heading", heading: { id, parent: null, index: 0, depth: 0, level: 1, title } };
}

function baseProps(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  return {
    view: "tree" as const,
    onViewChange: vi.fn(),
    crdt: null,
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

describe("Sidebar", () => {
  it("shows TreeView when view is 'tree'", () => {
    render(<Sidebar {...baseProps({ entries: [heading("a", "Alpha")] })} />);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(document.querySelector(".tree-view")).toBeInTheDocument();
    expect(document.querySelector(".mindmap-view")).not.toBeInTheDocument();
  });

  it("shows MindMapView when view is 'mindmap'", () => {
    render(<Sidebar {...baseProps({ view: "mindmap", entries: [heading("a", "Alpha")] })} />);
    expect(document.querySelector(".mindmap-view")).toBeInTheDocument();
    expect(document.querySelector(".tree-view")).not.toBeInTheDocument();
  });

  it("clicking the graph rail button switches to the mindmap view", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    render(<Sidebar {...baseProps({ onViewChange })} />);
    await user.click(screen.getByRole("tab", { name: /mind map/i }));
    expect(onViewChange).toHaveBeenCalledWith("mindmap");
  });

  it("clicking the tree rail button switches back to the tree view", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    render(<Sidebar {...baseProps({ view: "mindmap", onViewChange })} />);
    await user.click(screen.getByRole("tab", { name: /^tree$/i }));
    expect(onViewChange).toHaveBeenCalledWith("tree");
  });

  it("clicking the history rail button switches to the history view", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    render(<Sidebar {...baseProps({ onViewChange })} />);
    await user.click(screen.getByRole("tab", { name: /^history$/i }));
    expect(onViewChange).toHaveBeenCalledWith("history");
  });

  it("renders nothing for the history view when crdt isn't open yet", () => {
    render(<Sidebar {...baseProps({ view: "history", crdt: null })} />);
    expect(document.querySelector(".history-view")).not.toBeInTheDocument();
  });

  it("marks the active rail tab via aria-selected", () => {
    render(<Sidebar {...baseProps({ view: "mindmap" })} />);
    expect(screen.getByRole("tab", { name: /mind map/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /^tree$/i })).toHaveAttribute("aria-selected", "false");
  });

  it("renders a close button only when onClose is given", () => {
    const { rerender } = render(<Sidebar {...baseProps()} />);
    expect(screen.queryByLabelText(/close sidebar/i)).not.toBeInTheDocument();

    const onClose = vi.fn();
    rerender(<Sidebar {...baseProps({ onClose })} />);
    expect(screen.getByLabelText(/close sidebar/i)).toBeInTheDocument();
  });
});
