// The heading outline (plus `@`-links, interleaved) as a navigation menu —
// not a CRUD surface. There's nothing to create/rename/move/delete here for
// headings — a heading's text, level, and position are just part of the
// document, edited by typing in it directly (that's the whole point of the
// flat-document model — see dendroid_core::outline). Clicking a heading row
// makes it the editor's root (see `onReroot`); clicking its chevron
// expands/collapses it instead.
//
// `@`-link rows work the same way, but standing in for a *reference* rather
// than real document structure: clicking one jumps to its target instead of
// selecting the row itself, and expanding one shows a read-only, depth-
// limited preview of the target's subtree nested underneath — the same
// "both surfaces" preview `ux/editor/tiptap/linkRef.ts` renders inline in the
// editor, built from the same `subtreeRows` helper (`lib/crdt/outline.ts`)
// so the two never disagree about what counts as "the target's subtree".
//
// Fold/expand state itself isn't owned here — headings' lives in the
// editor's headingFold plugin, links' in its linkRef plugin (see
// `ux/editor/tiptap/headingFold.ts`/`linkRef.ts`) — and is only mirrored down via
// Workspace, so toggling a row here and toggling it in the editor go
// through the exact same state.

import type { HeadingDto, LinkEntryDto, OutlineEntry } from "../../lib/crdt/outline";
import { subtreeRows } from "../../lib/crdt/outline";
import { ChevronIcon, LogoIcon } from "../../ui/icons";
import { SidePanelHeader } from "../../ui/SidePanelHeader";

interface TreeViewProps {
  entries: OutlineEntry[];
  collapsedIds: ReadonlySet<string>;
  /** Mirrored from the editor's linkRef plugin — which `@`-links currently
   * show their expanded preview (see this file's header comment). */
  expandedLinkIds: ReadonlySet<string>;
  /** Levels of an expanded link's subtree to preview — mirrors
   * `AppSettings.descendantDepth`, the same knob the editor's own preview
   * uses (`Editor.tsx`'s `initialExpandedDepth`). */
  previewDepth: number;
  /** The heading the editor is currently scoped to, if any — mirrored down
   * from the editor's docRoot plugin (see Editor.tsx). The row for this
   * heading is marked as the current root (`tree-row--is-root`); the
   * headings within its subtree resolve their levels relative to it. */
  rootId: string | null;
  /** Selects/scrolls to a heading — used for an `@`-link row (jumps to its
   * target) and a preview row (jumps to that heading). A heading row itself
   * doesn't use this: clicking it reroots instead (see `onReroot`). */
  onSelectHeading: (id: string) => void;
  onToggleCollapse: (id: string) => void;
  onToggleLinkExpand: (id: string) => void;
  /** Makes `id` the editor's root — what clicking a heading row calls.
   * Routes back through an editor command (see Workspace's `reroot`) so the
   * tree and editor never disagree on which heading, if any, is currently
   * the root. */
  onReroot: (id: string) => void;
}

export function TreeView({
  entries,
  collapsedIds,
  expandedLinkIds,
  previewDepth,
  rootId,
  onSelectHeading,
  onToggleCollapse,
  onToggleLinkExpand,
  onReroot,
}: TreeViewProps) {
  const hasHeadings = entries.some((e) => e.kind === "heading");
  const rows = visibleRows(entries, collapsedIds, expandedLinkIds, previewDepth);
  // Bounds both the box drawn around the root heading's subtree
  // (`.tree-row--root-group`, workspace.css) and the level resolution below.
  const rootSubtree = rootSubtreeRange(rows, rootId);
  // The rooted heading's own level, if any — used to resolve every heading
  // row in its subtree to a level *relative to it* (so the root row always
  // reads as "#"), the same relative-to-root resolution docRoot.ts applies
  // to the editor's own heading sizing. Rows outside the subtree aren't
  // part of the root's descendants, so they keep showing their literal
  // level.
  const rootLevel = rootId ? rows.find((row) => row.kind === "heading" && row.heading?.id === rootId)?.heading?.level : undefined;

  return (
    <div className="side-panel tree-view">
      <SidePanelHeader icon={<LogoIcon size={16} />} label="Tree" />
      <div className="tree-view__rows">
        {!hasHeadings && <div className="tree-view__empty">No headings yet — start writing.</div>}
        {rows.map((row, i) => {
          if (row.kind === "preview") {
            const heading = row.heading!;
            return (
              <div
                key={row.key}
                className="tree-row tree-row--preview"
                style={{ paddingLeft: 14 + row.depth * 16 }}
                onClick={() => onSelectHeading(heading.id)}
              >
                <span className="tree-row__chevron tree-row__chevron--empty" />
                <span className="tree-row__title">{heading.title || "Untitled"}</span>
              </div>
            );
          }

          if (row.kind === "link") {
            const link = row.link!;
            const foldable = row.hasChildren;
            const isExpanded = expandedLinkIds.has(link.id);
            const title = link.staleTitle ?? (link.targetId ? undefined : "Deleted heading");
            return (
              <div
                key={row.key}
                className={`tree-row tree-row--link${link.targetId ? "" : " tree-row--orphaned"}`}
                style={{ paddingLeft: 14 + row.depth * 16 }}
                onClick={() => link.targetId && onSelectHeading(link.targetId)}
              >
                <span
                  className={`tree-row__chevron${foldable ? "" : " tree-row__chevron--empty"}${isExpanded ? " is-expanded" : ""}`}
                  onClick={(event) => {
                    if (!foldable) return;
                    event.stopPropagation();
                    onToggleLinkExpand(link.id);
                  }}
                >
                  {foldable && <ChevronIcon size={10} />}
                </span>
                <span className="tree-row__title">@ {title ?? linkTitle(entries, link)}</span>
              </div>
            );
          }

          const heading = row.heading!;
          const isRoot = heading.id === rootId;
          const inRootSubtree = i >= rootSubtree.start && i < rootSubtree.end;
          const displayLevel =
            inRootSubtree && rootLevel !== undefined ? Math.max(heading.level - rootLevel + 1, 1) : Math.max(heading.level, 1);
          const groupClass = inRootSubtree
            ? ` tree-row--root-group${i === rootSubtree.start ? " tree-row--root-group-first" : ""}${
                i === rootSubtree.end - 1 ? " tree-row--root-group-last" : ""
              }`
            : "";
          return (
            <div
              key={row.key}
              className={`tree-row${groupClass}${isRoot ? " tree-row--is-root" : ""}`}
              style={{ paddingLeft: 14 + row.depth * 16 }}
              title={isRoot ? "Reset root" : "Set as root"}
              onClick={() => onReroot(heading.id)}
            >
              <span
                className={`tree-row__chevron${row.hasChildren ? "" : " tree-row__chevron--empty"}${
                  row.hasChildren && !collapsedIds.has(heading.id) ? " is-expanded" : ""
                }`}
                onClick={(event) => {
                  if (!row.hasChildren) return;
                  event.stopPropagation();
                  onToggleCollapse(heading.id);
                }}
              >
                {row.hasChildren && <ChevronIcon size={10} />}
              </span>
              <span className="tree-row__title">{heading.title || "Untitled"}</span>
              <span className="tree-row__level">{"#".repeat(displayLevel)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface Row {
  key: string;
  depth: number;
  kind: "heading" | "link" | "preview";
  hasChildren: boolean;
  heading?: HeadingDto;
  link?: LinkEntryDto;
}

/** Rows to actually render: skip anything nested under a collapsed heading
 * ancestor, and — for every expanded `@`-link — splice in a read-only
 * preview of its target's subtree right after it. `entries` arrives in
 * document order with each heading preceded by its ancestors and each link
 * filed right after whichever heading currently encloses it (see
 * `dendroid_core::outline::outline_with_links`), so a heading's *real*
 * descendants are exactly the run that follows it with strictly greater
 * depth — mirrors how `headingFold.ts`'s decoration pass walks the same
 * shape on the editor side. A link's preview rows aren't part of that run
 * (the target lives wherever it actually is in the document, not
 * necessarily near the link), so they're synthesized separately. */
function visibleRows(
  entries: OutlineEntry[],
  collapsedIds: ReadonlySet<string>,
  expandedLinkIds: ReadonlySet<string>,
  previewDepth: number,
): Row[] {
  const headings = entries.filter((e): e is Extract<OutlineEntry, { kind: "heading" }> => e.kind === "heading").map((e) => e.heading);
  const headingById = new Map(headings.map((h) => [h.id, h]));

  const rows: Row[] = [];
  let hideAtOrBelowDepth: number | null = null;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const depth = entry.kind === "heading" ? entry.heading.depth : entry.link.depth;

    if (hideAtOrBelowDepth !== null) {
      if (depth <= hideAtOrBelowDepth) hideAtOrBelowDepth = null;
      else continue;
    }

    if (entry.kind === "heading") {
      const heading = entry.heading;
      const next = entries[i + 1];
      const hasChildren = !!next && (next.kind === "heading" ? next.heading.depth : next.link.depth) > heading.depth;
      rows.push({ key: `h:${heading.id}`, kind: "heading", heading, depth: heading.depth, hasChildren });
      if (hasChildren && collapsedIds.has(heading.id)) hideAtOrBelowDepth = heading.depth;
      continue;
    }

    const link = entry.link;
    const target = link.targetId ? headingById.get(link.targetId) : undefined;
    rows.push({ key: `l:${link.id}`, kind: "link", link, depth: link.depth, hasChildren: !!target });

    if (target && expandedLinkIds.has(link.id)) {
      for (const previewHeading of subtreeRows(headings, target.id, previewDepth).slice(1)) {
        rows.push({
          key: `l:${link.id}:p:${previewHeading.id}`,
          kind: "preview",
          heading: previewHeading,
          depth: link.depth + (previewHeading.depth - target.depth),
          hasChildren: false,
        });
      }
    }
  }

  return rows;
}

/** The [start, end) span of `rows` that make up the root heading's own
 * subtree: its row plus whatever visible descendants follow it, bounded by
 * the next row back at or above the root's own depth. Drives both the box
 * drawn around the root's subtree and the relative heading-level resolution
 * above — with no explicit root (or one that isn't currently visible, e.g.
 * hidden under a collapsed ancestor) this spans every row, boxing the whole
 * tree and leaving level resolution a no-op since there's no `rootLevel` to
 * resolve against. */
function rootSubtreeRange(rows: Row[], rootId: string | null): { start: number; end: number } {
  const start = rootId ? rows.findIndex((row) => row.kind === "heading" && row.heading?.id === rootId) : -1;
  if (start === -1) return { start: 0, end: rows.length };

  const rootDepth = rows[start].depth;
  let end = rows.length;
  for (let i = start + 1; i < rows.length; i++) {
    if (rows[i].depth <= rootDepth) {
      end = i;
      break;
    }
  }

  return { start, end };
}

/** Falls back to "Untitled" only once we know the target genuinely has no
 * title to show — a target outside `entries` (shouldn't happen; every
 * heading a live link can point to is always in the same outline) reads as
 * "Untitled" too rather than throwing. */
function linkTitle(entries: OutlineEntry[], link: LinkEntryDto): string {
  if (!link.targetId) return "Untitled";
  const target = entries.find((e) => e.kind === "heading" && e.heading.id === link.targetId);
  return target?.kind === "heading" ? target.heading.title || "Untitled" : "Untitled";
}
