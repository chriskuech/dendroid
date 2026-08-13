// A graph visualization of the same outline TreeView renders (see
// `lib/crdt/outline.ts`'s `OutlineEntry`) — headings become nodes, parent/
// child structure becomes one kind of arrow, `@`-links become another.
// Layout is a plain top-down tree pass (see `layout`, below); positions are
// then draggable per-node, tracked separately from layout so re-running
// layout on every outline change (e.g. a keystroke elsewhere in the
// document) never snaps a node the user has already moved back to its
// default spot. Double-clicking a node hands off to the same
// `onSelectHeading` TreeView's rows use, so it opens in the editor exactly
// the same way a tree row click does.

import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { OutlineEntry } from "../../lib/crdt/outline";
import { GraphIcon } from "../icons";
import "../../styles/mindMap.css";

interface MindMapViewProps {
  entries: OutlineEntry[];
  /** Opens a node in the shared editor instance — same signature as
   * TreeView's `onSelectHeading` (see Workspace.tsx's `selectHeading`). */
  onSelectHeading: (id: string) => void;
}

interface GraphNode {
  id: string;
  title: string;
  depth: number;
  parent: string | null;
}

interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: "tree" | "link";
}

interface Point {
  x: number;
  y: number;
}

const NODE_R = 5;
const COL_W = 130;
const ROW_H = 34;
const PAD = 28;
const DRAG_THRESHOLD = 3;

/** Headings become nodes; parent/child structure and `@`-links become the
 * two edge kinds. An orphaned link (deleted target) or one whose enclosing
 * heading isn't resolvable draws nothing — same "nothing to point at" case
 * TreeView renders as "Deleted heading" instead of a jump target. */
function buildGraph(entries: OutlineEntry[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const ids = new Set<string>();

  for (const entry of entries) {
    if (entry.kind !== "heading") continue;
    const h = entry.heading;
    ids.add(h.id);
    nodes.push({ id: h.id, title: h.title || "Untitled", depth: h.depth, parent: h.parent });
  }

  const edges: GraphEdge[] = [];
  for (const node of nodes) {
    if (node.parent && ids.has(node.parent)) {
      edges.push({ id: `t:${node.parent}:${node.id}`, from: node.parent, to: node.id, kind: "tree" });
    }
  }
  for (const entry of entries) {
    if (entry.kind !== "link") continue;
    const l = entry.link;
    if (!l.targetId || !l.parent || l.parent === l.targetId) continue;
    if (!ids.has(l.targetId) || !ids.has(l.parent)) continue;
    edges.push({ id: `l:${l.id}`, from: l.parent, to: l.targetId, kind: "link" });
  }

  return { nodes, edges };
}

/** Plain top-down tree layout: x from depth, y from an in-order leaf walk
 * (a parent centers over the span of its children) — same "document order
 * is sibling order" assumption TreeView's own row layout relies on. Doesn't
 * know about `@`-links at all; those are drawn wherever their two endpoint
 * nodes already ended up. */
function layout(nodes: GraphNode[]): Map<string, Point> {
  const byParent = new Map<string | null, GraphNode[]>();
  for (const node of nodes) {
    const list = byParent.get(node.parent);
    if (list) list.push(node);
    else byParent.set(node.parent, [node]);
  }

  const ids = new Set(nodes.map((n) => n.id));
  const positions = new Map<string, Point>();
  let nextLeafSlot = 0;

  function visit(node: GraphNode): number {
    const children = byParent.get(node.id) ?? [];
    const y = children.length === 0 ? nextLeafSlot++ : (visit(children[0]) + visit(children[children.length - 1])) / 2;
    positions.set(node.id, { x: node.depth * COL_W + PAD, y: y * ROW_H + PAD });
    return y;
  }

  for (const node of nodes) {
    if (!node.parent || !ids.has(node.parent)) visit(node);
  }

  return positions;
}

/** Trims a `from -> to` line so its arrowhead lands just outside the
 * target's circle instead of under it. */
function edgeLine(from: Point, to: Point): { x1: number; y1: number; x2: number; y2: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;
  return {
    x1: from.x + ux * NODE_R,
    y1: from.y + uy * NODE_R,
    x2: to.x - ux * (NODE_R + 3),
    y2: to.y - uy * (NODE_R + 3),
  };
}

export function MindMapView({ entries, onSelectHeading }: MindMapViewProps) {
  const { nodes, edges } = useMemo(() => buildGraph(entries), [entries]);
  const defaultPositions = useMemo(() => layout(nodes), [nodes]);
  // Only nodes the user has actually dragged live here — everything else
  // reads straight from `defaultPositions`, so an outline change (e.g.
  // typing elsewhere) that leaves a node's structural position untouched
  // never fights with a drag the user already made.
  const [dragOverrides, setDragOverrides] = useState<Map<string, Point>>(new Map());
  const dragState = useRef<{ id: string; startX: number; startY: number; origin: Point; moved: boolean } | null>(null);

  const positions = useMemo(() => {
    const map = new Map<string, Point>();
    for (const node of nodes) map.set(node.id, dragOverrides.get(node.id) ?? defaultPositions.get(node.id)!);
    return map;
  }, [nodes, defaultPositions, dragOverrides]);

  const bounds = useMemo(() => {
    let maxX = 0;
    let maxY = 0;
    for (const pos of positions.values()) {
      maxX = Math.max(maxX, pos.x);
      maxY = Math.max(maxY, pos.y);
    }
    return { width: maxX + PAD + 160, height: maxY + PAD + 20 };
  }, [positions]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<SVGGElement>, node: GraphNode) => {
      if (event.button !== 0) return;
      const origin = positions.get(node.id);
      if (!origin) return;
      // Optional-chained: real browsers always have this, but jsdom (tests)
      // doesn't implement pointer capture at all.
      event.currentTarget.setPointerCapture?.(event.pointerId);
      dragState.current = { id: node.id, startX: event.clientX, startY: event.clientY, origin, moved: false };
    },
    [positions],
  );

  const handlePointerMove = useCallback((event: ReactPointerEvent<SVGGElement>) => {
    const drag = dragState.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) drag.moved = true;
    if (!drag.moved) return;
    setDragOverrides((prev) => {
      const next = new Map(prev);
      next.set(drag.id, { x: drag.origin.x + dx, y: drag.origin.y + dy });
      return next;
    });
  }, []);

  const handlePointerUp = useCallback((event: ReactPointerEvent<SVGGElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
    dragState.current = null;
  }, []);

  return (
    <div className="mindmap-view">
      <div className="mindmap-view__header">
        <GraphIcon size={16} />
        <span className="mindmap-view__label">Mind Map</span>
      </div>
      <div className="mindmap-view__canvas">
        {nodes.length === 0 ? (
          <div className="mindmap-view__empty">No headings yet — start writing.</div>
        ) : (
          <svg className="mindmap-view__svg" width={bounds.width} height={bounds.height}>
            <defs>
              <marker id="mindmap-arrow-tree" viewBox="0 0 8 8" refX={7} refY={4} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 Z" className="mindmap-arrowhead mindmap-arrowhead--tree" />
              </marker>
              <marker id="mindmap-arrow-link" viewBox="0 0 8 8" refX={7} refY={4} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 Z" className="mindmap-arrowhead mindmap-arrowhead--link" />
              </marker>
            </defs>
            <g className="mindmap-view__edges">
              {edges.map((edge) => {
                const from = positions.get(edge.from);
                const to = positions.get(edge.to);
                if (!from || !to) return null;
                const { x1, y1, x2, y2 } = edgeLine(from, to);
                return (
                  <line
                    key={edge.id}
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    className={`mindmap-edge mindmap-edge--${edge.kind}`}
                    markerEnd={`url(#mindmap-arrow-${edge.kind})`}
                  />
                );
              })}
            </g>
            <g className="mindmap-view__nodes">
              {nodes.map((node) => {
                const pos = positions.get(node.id)!;
                return (
                  <g
                    key={node.id}
                    className="mindmap-node"
                    data-heading-id={node.id}
                    transform={`translate(${pos.x}, ${pos.y})`}
                    onPointerDown={(event) => handlePointerDown(event, node)}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onDoubleClick={() => onSelectHeading(node.id)}
                  >
                    <circle r={NODE_R} className="mindmap-node__dot" />
                    <text x={NODE_R + 6} y={4} className="mindmap-node__label">
                      {node.title}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        )}
      </div>
    </div>
  );
}
