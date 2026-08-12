// A section wraps one heading and everything nested under it (body
// content, and further nested `section`s for subheadings) into a single
// node — the frontend half of `dendroid_core::outline`'s `section` shape
// (see that module's doc comment for the full rationale: this is what
// makes a heading's whole subtree one addressable Loro container, via
// `loro-prosemirror`'s per-node container binding, instead of an inferred
// range within one flat list).
//
// `id` — what the outline, `@`-links, and "scroll to heading" navigation
// address a heading by — lives here now, not on the `heading` node it
// wraps (see `stableId.ts`; used to live in `headingId.ts`, back when
// headings were flat top-level siblings with no wrapper of their own).
//
// A section's own `content` expression is deliberately looser than the
// Rust side's *stored* shape (which is always exactly "one heading, then
// body") in one specific way — a heading can appear again anywhere *after*
// the first (`"heading (block | heading)*"`, not `"heading block*"`) —
// that's what lets TipTap's own heading input rule (`# `, `## `, ... — a
// plain in-place `setBlockType`, not a restructuring transform) land a
// *second* heading wherever the cursor happens to be inside a section's
// body without the single step that creates it being schema-invalid.
// `sectionStructure.ts`'s `appendTransaction` pass is what actually
// enforces "every heading past the first owns a fresh nested section of
// its own" immediately afterward — same two-step idiom `stableId.ts`
// already uses for ids (a permissive-past-the-minimum schema, with a
// follow-up pass making the rest of the invariant true rather than the
// schema itself).
//
// `block` has to come *before* `heading` in that repeated choice, not
// after — verified the hard way (an interactive check, not just this
// comment): `prosemirror-commands`' default Enter handling asks the
// schema what its *preferred* fill type is for a new empty slot right
// after the cursor, and picks whichever alternative is listed first.
// `"heading (heading | block)*"` made that heading — so pressing Enter at
// the end of any heading kept minting a new heading (of the same level)
// instead of dropping into an ordinary body paragraph, which is what
// every other outline/notes app (and this one, pre-nesting) does by
// default; explicit headings should only ever come from typing `#`, never
// from Enter alone.
//
// The *first* child is a hard schema requirement, though (not left to the
// fixup pass) — a section with no heading at all is exactly the state
// that broke things: `schema.topNodeType.createAndFill()` (what a
// brand-new/empty document seeds itself with, and what
// `loro-prosemirror`'s own initial sync falls back to when the backing
// Loro map is empty) only fills in what a content expression *requires*,
// so `"(heading | block)*"` alone — heading fully optional — produced a
// genuinely empty section with nothing loro-prosemirror could map a node
// onto. Requiring the leading heading means every section, including the
// auto-seeded empty one, always has exactly what its own identity
// depends on.

import { Node, mergeAttributes, type NodeConfig } from "@tiptap/core";
import { createStableIdPlugin } from "./stableId";

/** Shared by `Section` (the ordinary nested node every other section in
 * the app uses) and `EmbeddedSectionRoot` (`embeddedEditor.ts` — the
 * *topNode* a live embedded editor's schema uses, so its `editorState.doc`
 * — what `loro-prosemirror`'s exported `updateLoroToPmState` diffs against
 * the bound container — is itself named "section", matching what's
 * actually stored there; see that file's header comment for why). Same
 * node type in spirit either way: only whether *this schema* designates
 * it as top differs, never its shape. */
function sectionNodeConfig(topNode: boolean): NodeConfig {
  return {
    name: "section",
    topNode,
    group: "block section",
    content: "heading (block | heading)*",
    defining: true,
    isolating: true,

    addAttributes() {
      return {
        id: {
          default: null,
          parseHTML: (element: HTMLElement) => element.getAttribute("data-section-id"),
          renderHTML: (attributes: { id?: string | null }) =>
            attributes.id ? { "data-section-id": attributes.id } : {},
        },
      };
    },

    parseHTML() {
      return [{ tag: "section[data-section]" }];
    },

    renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) {
      return ["section", mergeAttributes(HTMLAttributes, { "data-section": "" }), 0];
    },

    addProseMirrorPlugins() {
      return [createStableIdPlugin("sectionId", ["section"])];
    },
  };
}

export const Section = Node.create(sectionNodeConfig(false));

/** The *topNode* variant — used only by `embeddedEditor.ts`'s schema, in
 * place of both `DocumentWithSections` and `Section`. A live embedded
 * editor's own `editorState.doc` *is* the target section (same id, same
 * content) rather than a generic "doc" wrapping it as a child — see
 * `embeddedEditor.ts`'s header comment for exactly why that distinction
 * is load-bearing, not stylistic. */
export const EmbeddedSectionRoot = Node.create(sectionNodeConfig(true));

/** The top-level document node, replacing `@tiptap/extension-document`'s
 * default `content: "block+"` (bundled by `StarterKit`, disabled via
 * `document: false` — see `Editor.tsx`) — the document is always a
 * sequence of one or more sections now, never bare blocks at the top
 * level. A brand-new/empty document seeds one empty section (with an
 * empty, level-1 heading) automatically, the same way TipTap's own
 * default document schema seeds one empty paragraph — see `Placeholder`'s
 * config in `Editor.tsx` for the resulting "Untitled" cue on that heading. */
export const DocumentWithSections = Node.create({
  name: "doc",
  topNode: true,
  content: "section+",
});
