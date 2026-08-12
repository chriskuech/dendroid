// Headless heading-outline command. The live UI doesn't call this — it
// reads the outline straight out of its own Loro mirror instead (see
// DendroidDocument.snapshotOutline), to avoid a Tauri round trip on every
// keystroke. This wrapper exists for parity with the Rust side and for
// anything that needs the outline without a live mirror around (tests,
// debugging).

import { invoke } from "@tauri-apps/api/core";

/** Mirrors `dendroid_core::outline::HeadingDto`. */
export interface HeadingDto {
  id: string;
  parent: string | null;
  index: number;
  depth: number;
  level: number;
  title: string;
}

export function fetchOutline(): Promise<HeadingDto[]> {
  return invoke<HeadingDto[]>("doc_outline");
}

/** Mirrors `dendroid_core::links::LinkEntryDto` — an `@`-link positioned in
 * the outline, nested under whichever heading currently encloses it. */
export interface LinkEntryDto {
  id: string;
  targetId: string | null;
  staleTitle: string | null;
  parent: string | null;
  depth: number;
}

/** Mirrors `dendroid_core::outline::OutlineEntry` — the tagged union
 * `DendroidDocument.snapshotOutlineWithLinks` and TreeView's "both
 * surfaces" rendering use so headings and `@`-links can interleave in one
 * document-order pass. */
export type OutlineEntry = { kind: "heading"; heading: HeadingDto } | { kind: "link"; link: LinkEntryDto };

/** `targetId` and its descendants, up to `maxDepth` levels past it —
 * everything from `targetId`'s own row in `outline` up to (not including)
 * the next row at or above its depth, dropping rows deeper than
 * `maxDepth` beyond it. Shared by an expanded `@`-link's read-only preview
 * in both the editor (`lib/tiptap/linkRef.ts`) and the tree view
 * (`components/tree/TreeView.tsx`), and by `TreeView.tsx`'s own
 * `visibleRows`/`rootGroupRange` for a heading's ordinary children. */
export function subtreeRows(outline: readonly HeadingDto[], targetId: string, maxDepth: number): HeadingDto[] {
  const start = outline.findIndex((h) => h.id === targetId);
  if (start === -1) return [];

  const root = outline[start];
  const rows = [root];
  for (let i = start + 1; i < outline.length; i++) {
    const h = outline[i];
    if (h.depth <= root.depth) break;
    if (h.depth - root.depth > maxDepth) continue;
    rows.push(h);
  }
  return rows;
}
