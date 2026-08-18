// Ranking for the `@`-link typeahead: candidates ordered by tree distance
// from the heading the cursor is currently inside, then alphabetically —
// per the whitepaper ("typeahead completion of headings, ordered by their
// distance from the current block"). Pure outline math over the same
// `HeadingDto[]` shape `DendroidDocument.snapshotOutline()` already
// produces, so this needs no round trip and stays framework-agnostic
// (no ProseMirror/TipTap imports here — see `linkRef.ts` for the plugin
// that finds "the current heading" from the live editor selection and
// calls into this).

import type { HeadingDto } from "../../../lib/crdt/outline";

const MAX_RESULTS = 20;

/** `headings` ranked by distance from `currentId` (the heading enclosing
 * the cursor, or `null` if the cursor isn't inside any heading yet — in
 * which case a heading's own depth stands in for its distance from that
 * implicit document root), filtered by a case-insensitive substring match
 * against `query`, capped to `MAX_RESULTS`. `currentId` itself is excluded
 * — linking a heading to itself isn't useful. */
export function rankHeadingsByDistance(headings: readonly HeadingDto[], currentId: string | null, query: string): HeadingDto[] {
  const byId = new Map(headings.map((h) => [h.id, h]));
  const q = query.trim().toLowerCase();

  const scored = headings
    .filter((h) => h.id !== currentId)
    .filter((h) => q.length === 0 || h.title.toLowerCase().includes(q))
    .map((h) => ({ heading: h, distance: treeDistance(byId, currentId, h.id) }));

  scored.sort((a, b) => a.distance - b.distance || a.heading.title.localeCompare(b.heading.title));
  return scored.slice(0, MAX_RESULTS).map((s) => s.heading);
}

/** Ancestor chain from `id` up to (and including) its outline root,
 * shallowest-last, i.e. `[id, parent, grandparent, ...]`. */
function ancestorChain(byId: Map<string, HeadingDto>, id: string): string[] {
  const chain: string[] = [];
  let current: string | null = id;
  while (current !== null) {
    chain.push(current);
    current = byId.get(current)?.parent ?? null;
  }
  return chain;
}

function treeDistance(byId: Map<string, HeadingDto>, currentId: string | null, targetId: string): number {
  if (currentId === null) {
    // No enclosing heading (cursor is before the first heading, or the
    // doc has none yet) — the nearer a candidate is to the implicit
    // document root, the closer it reads as "distance from here".
    return byId.get(targetId)?.depth ?? 0;
  }
  if (currentId === targetId) return 0;

  const fromCurrent = ancestorChain(byId, currentId);
  const fromTarget = ancestorChain(byId, targetId);
  const currentDepth = new Map(fromCurrent.map((id, i) => [id, i]));

  for (let stepsFromTarget = 0; stepsFromTarget < fromTarget.length; stepsFromTarget++) {
    const stepsFromCurrent = currentDepth.get(fromTarget[stepsFromTarget]);
    if (stepsFromCurrent !== undefined) return stepsFromCurrent + stepsFromTarget;
  }
  // No common ancestor at all (shouldn't happen against one outline, but
  // fall back to "as far as possible" rather than throwing).
  return fromCurrent.length + fromTarget.length;
}

/** The id of the nearest enclosing `section` around `pos` in `doc` — "the
 * current node" the typeahead ranks distance from. Sections nest now (see
 * `section.ts`), so this is just `pos`'s own resolved ancestor chain,
 * innermost first — no separate outline walk needed. */
export function enclosingHeadingId(doc: import("@tiptap/pm/model").Node, pos: number): string | null {
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth >= 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name === "section" && node.attrs.id) return node.attrs.id as string;
  }
  return null;
}
