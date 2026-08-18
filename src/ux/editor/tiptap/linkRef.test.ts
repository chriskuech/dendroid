// The `allowExpand` gate in `buildDecorations` is the one thing standing
// between an `@`-link cycle (A embeds B, B embeds A) and recursively
// mounting live editors forever — `embeddedEditor.ts` sets `allowExpand:
// false` on every `LinkRef` instance it configures for exactly this reason
// (see both files' header comments). This suite tests that gate directly,
// at the exact point it's enforced, rather than through a full nested
// `Editor`/`DendroidDocument` mount (covered at the integration level in
// `ux/editor/Editor.integration.test.tsx`).

import { describe, expect, it } from "vitest";
import { Schema } from "prosemirror-model";
import { DecorationSet } from "@tiptap/pm/view";
import { buildDecorations, type DecorationOpts } from "./linkRef";
import type { HeadingDto } from "../../../lib/crdt/outline";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    linkRef: {
      group: "inline",
      inline: true,
      atom: true,
      attrs: { id: { default: null }, targetId: { default: null }, staleTitle: { default: null } },
    },
    text: { group: "inline" },
  },
});

function link(id: string, targetId: string | null) {
  return schema.nodes.linkRef.create({ id, targetId, staleTitle: null });
}

function outlineOf(...ids: string[]): HeadingDto[] {
  return ids.map((id) => ({ id, parent: null, index: 0, depth: 0, level: 1, title: id.toUpperCase() }));
}

function baseOpts(overrides: Partial<DecorationOpts> = {}): DecorationOpts {
  return {
    getOutline: () => outlineOf("a", "b"),
    previewDepth: 3,
    onNavigate: () => {},
    allowExpand: true,
    ...overrides,
  };
}

/** Every decoration `buildDecorations` produced for the link's own id,
 * distinguished by `side` — `0` is always the chip, `1` (only present when
 * expanded) the preview. */
function decorationsFor(set: DecorationSet) {
  return set.find().filter((d) => (d as unknown as { spec: { key?: string } }).spec.key?.startsWith("link1"));
}

describe("linkRef buildDecorations — the allowExpand recursion guard", () => {
  it("with allowExpand true and the link expanded, renders both the chip and a preview widget", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [link("link1", "b")])]);
    const decorations = decorationsFor(buildDecorations(doc, new Set(["link1"]), baseOpts({ allowExpand: true })));
    expect(decorations).toHaveLength(2);
  });

  it("with allowExpand false, the same expanded id renders only the chip — no preview widget at all", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [link("link1", "b")])]);
    const decorations = decorationsFor(buildDecorations(doc, new Set(["link1"]), baseOpts({ allowExpand: false })));
    expect(decorations).toHaveLength(1);
    expect((decorations[0] as unknown as { spec: { side: number } }).spec.side).toBe(0); // the chip, not a preview
  });

  it("allowExpand false ignores the expanded set entirely, regardless of how many links are marked expanded", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [link("link1", "b"), link("link2", "a")]),
    ]);
    const decorations = buildDecorations(doc, new Set(["link1", "link2"]), baseOpts({ allowExpand: false })).find();
    // One chip per link, zero previews — this is what actually stops a
    // second embedded level from ever mounting inside the first.
    expect(decorations).toHaveLength(2);
    for (const d of decorations) expect((d as unknown as { spec: { side: number } }).spec.side).toBe(0);
  });

  it("a self-referencing link (targetId equal to its own enclosing heading) still expands to exactly one bounded preview, not a recursive chain", () => {
    // buildPreview/buildStaticPreview render the target's subtree as
    // plain, inert rows (see linkRef.ts) — they never themselves walk the
    // doc for further linkRef nodes, so a link back to its own section
    // can't recursively re-trigger this same expansion logic.
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [link("link1", "a")])]);
    const decorations = decorationsFor(buildDecorations(doc, new Set(["link1"]), baseOpts({ allowExpand: true })));
    expect(decorations).toHaveLength(2); // chip + exactly one preview, not more
  });

  it("collapsed (not in the expanded set) never renders a preview, independent of allowExpand", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [link("link1", "b")])]);
    for (const allowExpand of [true, false]) {
      const decorations = decorationsFor(buildDecorations(doc, new Set(), baseOpts({ allowExpand })));
      expect(decorations).toHaveLength(1);
    }
  });

  it("an orphaned link (targetId null) never renders a preview even when marked expanded", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [link("link1", null)])]);
    const decorations = decorationsFor(buildDecorations(doc, new Set(["link1"]), baseOpts({ allowExpand: true })));
    expect(decorations).toHaveLength(1);
  });
});
