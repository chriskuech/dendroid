// Keeps the document's actual nesting in sync with what each heading's
// typed level implies — automatically, on every relevant transaction — so
// authoring stays exactly what it's always been (type `#`/`##`/`###` to
// set a heading's level; nesting was never a separate gesture) even though
// nesting is now real tree structure instead of something inferred on
// read (see `section.ts`'s header comment, and `dendroid_core::outline`'s).
//
// `section.ts`'s content expression is deliberately loose enough to let a
// heading land anywhere in a section's body — exactly what TipTap's own
// heading input rule does (an in-place `setBlockType`, not a restructuring
// transform). This `appendTransaction` pass is what turns that into the
// real invariant, in two kinds of fixup:
//
//  - **Demote**: a `heading` that isn't its section's first child gets
//    wrapped, together with whatever follows it up to the next heading at
//    or above its own level *within that same parent* (the same
//    "subtree" rule `dendroid_core::markdown`'s `find_section`/
//    `write_sections` apply), into a fresh child `section`, in place.
//  - **Promote**: a `section` whose own level is <= its parent section's
//    level doesn't belong nested there — it gets lifted out to become its
//    parent's own next sibling instead.
//
// A demote can produce a section that immediately needs promoting (e.g.
// typing a level-1 heading deep inside a level-3 one first lands, in
// place, as a level-3 section's new child); a promote can itself still be
// too deep relative to *its* new parent, needing another promote. Each
// fixup here only ever resolves the single most local issue — full
// convergence happens across as many `appendTransaction` rounds as it
// takes, the same way `stableId.ts`'s id-stamping does (ProseMirror
// re-runs every plugin's `appendTransaction` again whenever any of them
// appends a transaction — see that file's header comment). For any
// realistic document this settles in a handful of rounds, all within the
// same synchronous edit.
//
// Cost: extracting a slice and re-inserting it elsewhere is a genuine
// delete-then-insert as far as `loro-prosemirror` (and so Loro) can tell —
// a brand-new container, not the same one moved — so whatever rides along
// with a newly-typed or reparented heading loses its own fine-grained
// edit history at that moment, the same already-accepted trade-off
// `dendroid_core::markdown::ApplyMode::Replace` makes on the Rust side.
// It only happens right when a heading first lands somewhere it doesn't
// belong; everything typed afterward, inside its now-correct section, is
// an ordinary bounded edit again.
//
// KNOWN BUG, not yet fixed: verified via an interactive browser check
// (typing into a real `EditorView`, not just this file's own logic) that
// **promote** specifically — the branch that deletes a section from one
// place and re-inserts it somewhere else, rather than replacing content
// in place the way demote does — can drop or displace the first couple of
// characters typed immediately after it fires, even though the resulting
// document *structure* ends up correct and `EditorState.selection` maps
// through the transaction correctly in isolation (confirmed headless,
// against raw `prosemirror-model`/`-state`, no `EditorView` involved —
// see the verification script this file's tests were developed against).
// Reproduced with `loro-prosemirror` entirely removed from the extension
// list too, so it isn't a Loro-echo issue — this is specifically about
// `EditorView`'s DOM/selection resync lagging by roughly one keystroke
// right after a promote relocates a node's DOM subtree (a demote's
// in-place `replaceWith` doesn't show it; only promote's cross-parent
// delete+insert does). Only reachable by typing a heading whose level is
// shallow enough to need climbing back out past its *own* parent (not
// just landing as a nested child) — the common case, a heading nested
// exactly where you'd expect relative to what's above it, never hits this
// branch at all. Flagged rather than fixed in this pass; likely angles for
// whoever picks it up: an explicit `tr.setSelection`/`scrollIntoView` on
// the promote branch, or deferring the promote until the affected
// heading's text settles (blur/Enter) instead of firing on every
// keystroke.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

export const SectionStructure = Extension.create({
  name: "sectionStructure",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("sectionStructure"),
        appendTransaction(transactions, oldState, newState) {
          const docChanged = transactions.some((tr) => tr.docChanged) && !oldState.doc.eq(newState.doc);
          if (!docChanged) return null;

          const fix = findMisplacedHeading(newState.doc) ?? findPromotable(newState.doc);
          if (!fix) return null;

          return applyFix(newState.tr, fix);
        },
      }),
    ];
  },
});

/** Exported for `scripts/verify-section-structure.ts` (a headless,
 * DOM-free sanity check against raw `prosemirror-model`/`-state` — see
 * that script) and `sectionStructure.test.ts` (the same scenarios, as real
 * `bun run test` assertions) to exercise directly, without needing a full
 * `Editor`. */
export type StructuralFix =
  | { kind: "demote"; from: number; to: number }
  | { kind: "promote"; from: number; to: number; insertAt: number };

/** A `section`'s or bare `heading`'s own level, for comparing "does this
 * belong nested here" — `null` for anything else (plain body content,
 * which never bounds a heading's captured trailing run). */
export function levelOf(node: ProseMirrorNode): number | null {
  if (node.type.name === "heading") return (node.attrs.level as number) ?? 1;
  if (node.type.name === "section") return node.firstChild ? ((node.firstChild.attrs.level as number) ?? 1) : null;
  return null;
}

/** The first `heading` found that isn't its parent `section`'s own first
 * child, plus the run of trailing siblings (within that same parent) that
 * belong with it — everything up to (not including) the next child whose
 * own level is <= the misplaced heading's. */
export function findMisplacedHeading(doc: ProseMirrorNode): StructuralFix | null {
  let found: StructuralFix | null = null;

  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name !== "section") return true;

    let misplacedIndex = -1;
    let misplacedOffset = -1;
    let offset = 0;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (i > 0 && child.type.name === "heading") {
        misplacedIndex = i;
        misplacedOffset = offset;
        break;
      }
      offset += child.nodeSize;
    }
    if (misplacedIndex === -1) return true; // this section's own body is fine; keep descending into it

    const misplacedLevel = levelOf(node.child(misplacedIndex)) ?? 1;
    let endOffset = node.content.size;
    let scanOffset = misplacedOffset;
    for (let i = misplacedIndex; i < node.childCount; i++) {
      const sibling = node.child(i);
      if (i > misplacedIndex) {
        const level = levelOf(sibling);
        if (level !== null && level <= misplacedLevel) {
          endOffset = scanOffset;
          break;
        }
      }
      scanOffset += sibling.nodeSize;
    }

    const contentStart = pos + 1;
    found = { kind: "demote", from: contentStart + misplacedOffset, to: contentStart + endOffset };
    return false;
  });

  return found;
}

/** The first `section` found whose own level is <= its parent section's
 * level — it needs to become that parent's own next sibling instead. */
export function findPromotable(doc: ProseMirrorNode): StructuralFix | null {
  let found: StructuralFix | null = null;

  // `contentStart` is the absolute position of `node`'s own first content
  // slot — 0 for `doc` itself (the top node has no "opening token" of its
  // own consuming a position, unlike every other node), `childPos + 1` for
  // anything recursed into below. Keeping that distinction explicit here
  // (rather than uniformly doing `pos + 1 + offset`, which is only valid
  // once `pos` is a real node's own position) is what the original,
  // buggy version got wrong — verified against `scripts/
  // verify-section-structure.ts` (a level-1 heading typed deep inside a
  // level-3 section produced runaway empty sections instead of climbing
  // back out to the top).
  function walk(node: ProseMirrorNode, contentStart: number, ownLevel: number | null, insertAtIfPromoted: number) {
    node.forEach((child, offset) => {
      if (found) return;
      if (child.type.name !== "section") return;
      const childPos = contentStart + offset; // position right before `child` itself
      const level = levelOf(child) ?? 1;

      if (ownLevel !== null && level <= ownLevel) {
        found = { kind: "promote", from: childPos, to: childPos + child.nodeSize, insertAt: insertAtIfPromoted };
        return;
      }

      walk(child, childPos + 1, level, childPos + child.nodeSize);
    });
  }

  walk(doc, 0, null, -1);
  return found;
}

export function applyFix(tr: Transaction, fix: StructuralFix): Transaction {
  const sectionType = tr.doc.type.schema.nodes.section;

  if (fix.kind === "demote") {
    const wrapped = sectionType.create(null, tr.doc.slice(fix.from, fix.to).content);
    tr.replaceWith(fix.from, fix.to, wrapped);
    return tr;
  }

  const slice = tr.doc.slice(fix.from, fix.to);
  tr.delete(fix.from, fix.to);
  tr.insert(tr.mapping.map(fix.insertAt), slice.content);
  return tr;
}
