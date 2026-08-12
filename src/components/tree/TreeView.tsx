// The heading outline (plus `@`-links, interleaved) as a navigation menu —
// not a CRUD surface. There's nothing to create/rename/move/delete here for
// headings — a heading's text, level, and position are just part of the
// document, edited by typing in it directly (that's the whole point of the
// flat-document model — see dendroid_core::outline). Clicking a heading row
// scrolls/selects it in the shared editor instance; clicking its chevron
// expands/collapses it.
//
// `@`-link rows work the same way, but standing in for a *reference* rather
// than real document structure: clicking one jumps to its target instead of
// selecting the row itself, and expanding one shows a read-only, depth-
// limited preview of the target's subtree nested underneath — the same
// "both surfaces" preview `lib/tiptap/linkRef.ts` renders inline in the
// editor, built from the same `subtreeRows` helper (`lib/crdt/outline.ts`)
// so the two never disagree about what counts as "the target's subtree".
//
// Fold/expand state itself isn't owned here — headings' lives in the
// editor's headingFold plugin, links' in its linkRef plugin (see
// `lib/tiptap/headingFold.ts`/`linkRef.ts`) — and is only mirrored down via
// Workspace, so toggling a row here and toggling it in the editor go
// through the exact same state.

import type { CSSProperties } from "react";
import type { HeadingDto, LinkEntryDto, OutlineEntry } from "../../lib/crdt/outline";
import { subtreeRows } from "../../lib/crdt/outline";
import { ChevronIcon, CloseIcon, LogoIcon, RerootIcon } from "../icons";

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
   * heading gets boxed. */
  rootId: string | null;
  /** Selects/scrolls to a heading — used for a heading row, an `@`-link
   * row (jumps to its target), and a preview row (jumps to that heading). */
  onSelectHeading: (id: string) => void;
  onToggleCollapse: (id: string) => void;
  onToggleLinkExpand: (id: string) => void;
  /** Toggles `id` as the editor's root — routes back through an editor
   * command (see Workspace's `reroot`) so the tree and editor never
   * disagree on which heading, if any, is currently the root. */
  onReroot: (id: string) => void;
  /** True once zen mode has faded the chrome (see useZenChrome /
   * whitepaper.md's Editor > Mode section). Opacity + pointer-events only —
   * layout never changes, so nothing reflows while the fade runs. Only
   * meaningful for the persistent (>=900px) sidebar; the drawer manages its
   * own opacity via `drawerStyle` instead. */
  faded?: boolean;
  /** Transition duration to pair with `faded`, from the same `useZenChrome`
   * call (via AppState) that produced it — kept as one source of timing
   * rather than re-guessing it here, so every faded piece of chrome (this
   * sidebar, the settings launcher) animates in lockstep. */
  transitionMs?: number;
  /** Present only in the <900px drawer variant (see Workspace.tsx) — swaps
   * in a close icon and lets the caller drive the deblur-in/out transition
   * from outside, since the drawer's own open/closed state lives there. */
  onClose?: () => void;
  drawerStyle?: CSSProperties;
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
  faded = false,
  transitionMs = 120,
  onClose,
  drawerStyle,
}: TreeViewProps) {
  const hasHeadings = entries.some((e) => e.kind === "heading");
  const rows = visibleRows(entries, collapsedIds, expandedLinkIds, previewDepth);
  const rootGroup = rootGroupRange(rows, rootId);
  // The rooted heading's own level, if any — used to resolve every heading
  // row in its group to a level *relative to it* (so the root row always
  // reads as "#"), the same relative-to-root resolution docRoot.ts applies
  // to the editor's own heading sizing. Rows outside the group aren't part
  // of the root's subtree, so they keep showing their literal level.
  const rootLevel = rootId ? rows.find((row) => row.kind === "heading" && row.heading?.id === rootId)?.heading?.level : undefined;

  const style: CSSProperties = drawerStyle ?? {
    opacity: faded ? 0 : 1,
    pointerEvents: faded ? "none" : "auto",
    transition: `opacity ${transitionMs}ms cubic-bezier(0.2, 0, 0, 1)`,
  };

  return (
    <div className={`tree-view${onClose ? " tree-view--drawer" : ""}`} style={style}>
      <div className="tree-view__header">
        <LogoIcon size={16} />
        <span className="tree-view__label">Tree</span>
        {onClose && (
          <button type="button" className="tree-view__close" onClick={onClose} aria-label="Close tree">
            <CloseIcon size={16} />
          </button>
        )}
      </div>
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
          const inRootGroup = i >= rootGroup.start && i < rootGroup.end;
          const displayLevel =
            inRootGroup && rootLevel !== undefined ? Math.max(heading.level - rootLevel + 1, 1) : Math.max(heading.level, 1);
          const groupClass = inRootGroup
            ? ` tree-row--root-group${i === rootGroup.start ? " tree-row--root-group-first" : ""}${
                i === rootGroup.end - 1 ? " tree-row--root-group-last" : ""
              }`
            : "";
          return (
            <div
              key={row.key}
              className={`tree-row${groupClass}`}
              style={{ paddingLeft: 14 + row.depth * 16 }}
              onClick={() => onSelectHeading(heading.id)}
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
              <span
                className={`tree-row__reroot${isRoot ? " is-root" : ""}`}
                title={isRoot ? "Reset root" : "Set as root"}
                onClick={(event) => {
                  event.stopPropagation();
                  onReroot(heading.id);
                }}
              >
                <RerootIcon size={12} />
              </span>
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

/** The [start, end) span of `rows` the root box wraps: the root heading's
 * row plus whatever visible descendants follow it, bounded by the next row
 * back at or above the root's own depth. With no explicit root (or one
 * that isn't currently visible, e.g. hidden under a collapsed ancestor) the
 * page itself is the root, so the whole tree gets the box. */
function rootGroupRange(rows: Row[], rootId: string | null): { start: number; end: number } {
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
