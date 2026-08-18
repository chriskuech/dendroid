// Covers MindMapView's graph construction (headings -> nodes, parent/child
// and `@`-links -> the two edge kinds), its double-click-to-open handoff to
// the editor, and drag-to-move — see TreeView.test.tsx for the sibling
// suite this mirrors the fixture style of.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MindMapView } from "./MindMapView";
import type { HeadingDto, LinkEntryDto, OutlineEntry } from "../../lib/crdt/outline";

function heading(id: string, depth: number, title: string, overrides: Partial<HeadingDto> = {}): OutlineEntry {
  return { kind: "heading", heading: { id, parent: null, index: 0, depth, level: depth + 1, title, ...overrides } };
}

function link(id: string, depth: number, targetId: string | null, overrides: Partial<LinkEntryDto> = {}): OutlineEntry {
  return { kind: "link", link: { id, targetId, staleTitle: null, parent: null, depth, ...overrides } };
}

function nodeGroup(id: string): SVGGElement {
  return document.querySelector(`.mindmap-node[data-heading-id="${id}"]`) as SVGGElement;
}

describe("MindMapView — graph construction", () => {
  it("shows the empty state when there are no headings", () => {
    render(<MindMapView entries={[]} onSelectHeading={vi.fn()} />);
    expect(screen.getByText(/no headings yet/i)).toBeInTheDocument();
  });

  it("renders one node per heading, with its title", () => {
    const entries = [heading("a", 0, "Alpha"), heading("b", 0, "Beta")];
    render(<MindMapView entries={entries} onSelectHeading={vi.fn()} />);
    expect(document.querySelectorAll(".mindmap-node")).toHaveLength(2);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("falls back to 'Untitled' for a heading with no title", () => {
    render(<MindMapView entries={[heading("a", 0, "")]} onSelectHeading={vi.fn()} />);
    expect(screen.getByText("Untitled")).toBeInTheDocument();
  });

  it("draws a tree edge, arrow pointing at the child, for every parent/child pair", () => {
    const entries = [heading("a", 0, "Alpha"), heading("a1", 1, "Child", { parent: "a" })];
    render(<MindMapView entries={entries} onSelectHeading={vi.fn()} />);
    const edges = document.querySelectorAll(".mindmap-edge--tree");
    expect(edges).toHaveLength(1);
    expect(edges[0].getAttribute("marker-end")).toBe("url(#mindmap-arrow-tree)");
  });

  it("draws a link edge, colored/marked differently from a tree edge, for an `@`-link", () => {
    const entries = [
      heading("a", 0, "Alpha"),
      heading("b", 0, "Beta"),
      link("l1", 0, "b", { parent: "a" }),
    ];
    render(<MindMapView entries={entries} onSelectHeading={vi.fn()} />);
    expect(document.querySelectorAll(".mindmap-edge--tree")).toHaveLength(0);
    const linkEdges = document.querySelectorAll(".mindmap-edge--link");
    expect(linkEdges).toHaveLength(1);
    expect(linkEdges[0].getAttribute("marker-end")).toBe("url(#mindmap-arrow-link)");
  });

  it("draws nothing for an orphaned link (no target)", () => {
    const entries = [heading("a", 0, "Alpha"), link("l1", 0, null, { parent: "a" })];
    render(<MindMapView entries={entries} onSelectHeading={vi.fn()} />);
    expect(document.querySelectorAll(".mindmap-edge")).toHaveLength(0);
  });

  it("draws nothing for a link whose enclosing heading equals its own target", () => {
    const entries = [heading("a", 0, "Alpha"), link("l1", 0, "a", { parent: "a" })];
    render(<MindMapView entries={entries} onSelectHeading={vi.fn()} />);
    expect(document.querySelectorAll(".mindmap-edge")).toHaveLength(0);
  });
});

describe("MindMapView — opening a node", () => {
  it("double-clicking a node opens it via onSelectHeading", async () => {
    const user = userEvent.setup();
    const onSelectHeading = vi.fn();
    render(<MindMapView entries={[heading("a", 0, "Alpha")]} onSelectHeading={onSelectHeading} />);
    await user.dblClick(screen.getByText("Alpha"));
    expect(onSelectHeading).toHaveBeenCalledWith("a");
  });
});

describe("MindMapView — drag to move", () => {
  it("dragging a node updates its position, and a later re-render keeps it there", () => {
    const entries = [heading("a", 0, "Alpha"), heading("b", 0, "Beta")];
    const { rerender } = render(<MindMapView entries={entries} onSelectHeading={vi.fn()} />);

    const group = nodeGroup("a");
    const before = group.getAttribute("transform");

    fireEvent.pointerDown(group, { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerMove(group, { pointerId: 1, clientX: 140, clientY: 160 });
    fireEvent.pointerUp(group, { pointerId: 1 });

    const after = nodeGroup("a").getAttribute("transform");
    expect(after).not.toBe(before);

    // A subsequent outline update (e.g. a title edited elsewhere) must not
    // snap the dragged node back to its default layout position.
    rerender(<MindMapView entries={entries} onSelectHeading={vi.fn()} />);
    expect(nodeGroup("a").getAttribute("transform")).toBe(after);
  });

  it("a plain click (no movement past the threshold) doesn't move the node", () => {
    const entries = [heading("a", 0, "Alpha")];
    render(<MindMapView entries={entries} onSelectHeading={vi.fn()} />);

    const group = nodeGroup("a");
    const before = group.getAttribute("transform");

    fireEvent.pointerDown(group, { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerMove(group, { pointerId: 1, clientX: 101, clientY: 100 });
    fireEvent.pointerUp(group, { pointerId: 1 });

    expect(nodeGroup("a").getAttribute("transform")).toBe(before);
  });
});
