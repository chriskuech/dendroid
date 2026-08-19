// Covers the rail-driven view switch itself (Sidebar's own job) — TreeView
// and MindMapView each have their own dedicated suites for what they render
// once selected.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
    selectedDatabaseId: null,
    onSelectDatabase: vi.fn(),
    onOpenSettings: vi.fn(),
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

  it("clicking the database rail button switches to the database view", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    render(<Sidebar {...baseProps({ onViewChange })} />);
    await user.click(screen.getByRole("tab", { name: /^databases$/i }));
    expect(onViewChange).toHaveBeenCalledWith("database");
  });

  it("shows the database list when view is 'database'", () => {
    render(<Sidebar {...baseProps({ view: "database" })} />);
    expect(document.querySelector(".database-list")).toBeInTheDocument();
    expect(document.querySelector(".tree-view")).not.toBeInTheDocument();
  });

  it("shows the database's own history instead of the tree's once a database is selected", () => {
    render(<Sidebar {...baseProps({ view: "history", selectedDatabaseId: "db-1" })} />);
    expect(document.querySelector(".history-view")).toBeInTheDocument();
    // Both HistoryView and DatabaseHistoryView render the same
    // `.history-view` shell — what distinguishes them here is that the
    // database one never touches `crdt` (which is `null` in these tests
    // and would otherwise render nothing per the test above).
    expect(screen.getByText("History")).toBeInTheDocument();
  });

  it("marks the active rail tab via aria-selected", () => {
    render(<Sidebar {...baseProps({ view: "mindmap" })} />);
    expect(screen.getByRole("tab", { name: /mind map/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /^tree$/i })).toHaveAttribute("aria-selected", "false");
  });

  it("clicking the settings rail button calls onOpenSettings", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    render(<Sidebar {...baseProps({ onOpenSettings })} />);
    await user.click(screen.getByRole("button", { name: /open settings/i }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("renders a close button only when onClose is given", () => {
    const { rerender } = render(<Sidebar {...baseProps()} />);
    expect(screen.queryByLabelText(/close sidebar/i)).not.toBeInTheDocument();

    const onClose = vi.fn();
    rerender(<Sidebar {...baseProps({ onClose })} />);
    expect(screen.getByLabelText(/close sidebar/i)).toBeInTheDocument();
  });

  it("renders no resize handle without both width and onResize (e.g. the <900px drawer)", () => {
    render(<Sidebar {...baseProps()} />);
    expect(screen.queryByLabelText(/resize sidebar/i)).not.toBeInTheDocument();
  });

  it("dragging the resize handle grows the content column live and commits the final width on release", () => {
    const onResize = vi.fn();
    render(<Sidebar {...baseProps({ width: 280, onResize })} />);
    const handle = screen.getByLabelText(/resize sidebar/i);

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 140 });
    expect(document.querySelector(".sidebar__content")).toHaveStyle({ width: "320px" });
    expect(onResize).not.toHaveBeenCalled();

    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(onResize).toHaveBeenCalledWith(320);
  });

  it("clamps a resize drag to the sidebar's min/max width", () => {
    const onResize = vi.fn();
    render(<Sidebar {...baseProps({ width: 280, onResize })} />);
    const handle = screen.getByLabelText(/resize sidebar/i);

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: -1000 });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(onResize).toHaveBeenCalledWith(220);
  });

  it("clicking the active rail icon in the nested (drawer) variant closes the drawer instead of re-selecting it", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    const onClose = vi.fn();
    render(<Sidebar {...baseProps({ view: "tree", onViewChange, onClose })} />);
    await user.click(screen.getByRole("tab", { name: /^tree$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onViewChange).not.toHaveBeenCalled();
  });

  it("clicking an inactive rail icon in the nested (drawer) variant still just switches views", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    const onClose = vi.fn();
    render(<Sidebar {...baseProps({ view: "tree", onViewChange, onClose })} />);
    await user.click(screen.getByRole("tab", { name: /mind map/i }));
    expect(onViewChange).toHaveBeenCalledWith("mindmap");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("clicking the active rail icon in the persistent (non-drawer) variant is a no-op select, not a close", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    render(<Sidebar {...baseProps({ view: "tree", onViewChange })} />);
    await user.click(screen.getByRole("tab", { name: /^tree$/i }));
    expect(onViewChange).toHaveBeenCalledWith("tree");
  });
});
