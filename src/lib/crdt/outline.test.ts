// `subtreeRows` is the one piece of logic every "expand a target's subtree"
// surface shares — the editor's `@`-link preview (`ux/editor/tiptap/linkRef.ts`),
// the tree view's `@`-link preview (`ux/tree/TreeView.tsx`), and
// the tree view's own ordinary-children rendering. Its `maxDepth` cutoff is
// also the *only* thing standing between an `@`-link and an unbounded (or,
// for a link that targets one of its own ancestors, genuinely cyclical)
// preview — so this file leans hard on that boundary.

import { describe, expect, it } from "vitest";
import { subtreeRows, type HeadingDto } from "./outline";

function heading(id: string, depth: number, overrides: Partial<HeadingDto> = {}): HeadingDto {
  return { id, parent: null, index: 0, depth, level: depth + 1, title: id, ...overrides };
}

describe("subtreeRows", () => {
  it("returns the target plus every descendant, in document order", () => {
    const outline = [heading("a", 0), heading("a1", 1), heading("a1a", 2), heading("a2", 1), heading("b", 0)];
    expect(subtreeRows(outline, "a", 10).map((h) => h.id)).toEqual(["a", "a1", "a1a", "a2"]);
  });

  it("stops at the next row back at or above the target's own depth", () => {
    // "b" is a sibling of "a", not a descendant — must not be included no
    // matter how large maxDepth is.
    const outline = [heading("a", 0), heading("a1", 1), heading("b", 0), heading("b1", 1)];
    expect(subtreeRows(outline, "a", 100).map((h) => h.id)).toEqual(["a", "a1"]);
  });

  it("truncates descendants past maxDepth levels below the target", () => {
    const outline = [heading("a", 0), heading("a1", 1), heading("a1a", 2), heading("a1a1", 3)];
    expect(subtreeRows(outline, "a", 1).map((h) => h.id)).toEqual(["a", "a1"]);
    expect(subtreeRows(outline, "a", 2).map((h) => h.id)).toEqual(["a", "a1", "a1a"]);
  });

  it("maxDepth 0 returns only the target row itself", () => {
    const outline = [heading("a", 0), heading("a1", 1)];
    expect(subtreeRows(outline, "a", 0).map((h) => h.id)).toEqual(["a"]);
  });

  it("returns [] for a target that isn't in the outline (stale/orphaned link)", () => {
    const outline = [heading("a", 0)];
    expect(subtreeRows(outline, "missing", 5)).toEqual([]);
  });

  it("a leaf target with no descendants returns just itself", () => {
    const outline = [heading("a", 0), heading("b", 0)];
    expect(subtreeRows(outline, "b", 5).map((h) => h.id)).toEqual(["b"]);
  });

  it("a target that is its own only occurrence never recurses past the real outline length — a self-referencing link (targetId === its own enclosing heading) still resolves to one bounded row, not an infinite preview", () => {
    // The outline itself can never contain the same heading id twice (each
    // section is one node in one document), so "A links to itself" can't
    // manifest as literal cyclic *data* here — what it actually produces is
    // a link whose targetId equals the id of the heading enclosing it. That
    // heading's own subtree (correctly) includes itself once; the
    // recursion risk lives entirely in whatever *renders* the link (see
    // `linkRef.test.ts`'s `allowExpand` coverage), not in this lookup.
    const outline = [heading("a", 0), heading("a1", 1)];
    expect(subtreeRows(outline, "a", 50).map((h) => h.id)).toEqual(["a", "a1"]);
  });

  it("a link targeting one of its own ancestors still yields a finite, correctly-bounded result", () => {
    // e.g. a link inside "a1a" pointing back up at "a" — reading "a"'s own
    // subtree from the top must not loop just because the *link* forms a
    // back-edge; subtreeRows only ever walks forward through `outline`.
    const outline = [heading("a", 0), heading("a1", 1), heading("a1a", 2)];
    expect(subtreeRows(outline, "a", 50).map((h) => h.id)).toEqual(["a", "a1", "a1a"]);
  });

  it("large maxDepth against a deep outline terminates immediately and takes exactly the whole subtree once", () => {
    const outline: HeadingDto[] = [];
    for (let i = 0; i < 500; i++) outline.push(heading(`h${i}`, i));
    const rows = subtreeRows(outline, "h0", Number.MAX_SAFE_INTEGER);
    expect(rows).toHaveLength(500);
    expect(rows[0].id).toBe("h0");
    expect(rows[499].id).toBe("h499");
  });
});
