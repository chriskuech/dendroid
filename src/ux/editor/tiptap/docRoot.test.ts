// `buildDecorations` walks from the schema's own top node (`doc`), which —
// unlike every other node — doesn't occupy a position of its own: position
// 0 is already the start of its content. Getting that starting position
// wrong throws off every top-level section's computed position by one, so
// each `Decoration.node` built for it (the out-of-root hide, the
// root-relative level class) silently fails to align to a node boundary
// and gets dropped — while the widget decorations (the reroot toggles)
// are lenient enough about position to still render, which is what makes a
// regression here easy to miss from the editor alone. This suite tests
// `buildDecorations` directly, at the point that broke, rather than only
// through a full `Editor`/`DendroidDocument` mount.

import { describe, expect, it } from "vitest";
import { Schema } from "prosemirror-model";
import { buildDecorations } from "./docRoot";

const schema = new Schema({
  nodes: {
    doc: { content: "section+" },
    section: { content: "heading (block | heading)*", attrs: { id: { default: null } } },
    heading: { content: "inline*", group: "block", attrs: { level: { default: 1 } } },
    paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" },
  },
});

function section(id: string, level: number, title: string, ...body: unknown[]) {
  return schema.nodes.section.create({ id }, [
    schema.nodes.heading.create({ level }, title ? schema.text(title) : undefined),
    ...(body as never[]),
  ]);
}

function paragraph(text: string) {
  return schema.nodes.paragraph.create(null, schema.text(text));
}

/** Class names actually applied at `pos` (both `Decoration.node`s at the
 * same node boundary and any widget's own class), independent of exactly
 * how many separate decorations produced them. */
function classesAt(decorations: ReturnType<typeof buildDecorations>, pos: number): string[] {
  return decorations
    .find(pos, pos)
    .filter((d) => (d as unknown as { type: { attrs?: { class?: string } } }).type.attrs?.class)
    .flatMap((d) => (d as unknown as { type: { attrs: { class: string } } }).type.attrs.class.split(" "));
}

describe("docRoot buildDecorations — root-scoping decorations at the top level", () => {
  it("hides a top-level sibling of the root and marks the root's own heading level-1", () => {
    const doc = schema.node("doc", null, [section("a", 1, "Alpha", paragraph("body a")), section("b", 1, "Beta", paragraph("body b"))]);
    const decorations = buildDecorations(doc, "b");

    // `a` is a section positioned at 0 — regression: this used to be
    // dropped entirely because `a`'s computed position was off by one.
    expect(classesAt(decorations, 0)).toContain("doc-root-hidden");

    // `b`'s own heading is the root, so it reads as level 1 ("#") even
    // though its literal level here already is 1 — same regression, this
    // decoration was silently dropped too.
    const bPos = doc.content.firstChild!.nodeSize; // position of section `b`
    expect(classesAt(decorations, bPos + 1)).toContain("doc-root-level-1");
  });

  it("relabels a rooted top-level section's descendant relative to the root, not its literal level", () => {
    const doc = schema.node("doc", null, [
      section("a", 1, "Alpha", section("a1", 2, "Alpha child")),
    ]);
    const decorations = buildDecorations(doc, "a");

    const childPos = 0 + doc.content.firstChild!.firstChild!.nodeSize + 1; // start of nested section "a1"
    expect(classesAt(decorations, childPos + 1)).toContain("doc-root-level-2");
  });

  it("hides an ancestor's own heading and body content, leaving only the path down to the root visible", () => {
    const doc = schema.node("doc", null, [
      section("a", 1, "Alpha", paragraph("body a"), section("a1", 2, "A1", paragraph("body a1"))),
    ]);
    const decorations = buildDecorations(doc, "a1");

    // "a" is the ancestor being zoomed past, not the root itself — its own
    // heading and body paragraph must be hidden along with it, not just
    // its out-of-path siblings (there are none here to begin with).
    const aSection = doc.content.firstChild!;
    const aHeading = aSection.firstChild!;
    const aHeadingPos = 1; // "a" is at 0 (top-level); its content starts one past that
    expect(classesAt(decorations, aHeadingPos)).toContain("doc-root-hidden");

    const aParagraph = aSection.child(1);
    const aParagraphPos = aHeadingPos + aHeading.nodeSize;
    expect(classesAt(decorations, aParagraphPos)).toContain("doc-root-hidden");

    // The rooted section "a1" itself — and its own heading/body — must
    // stay fully visible; only the ancestor's own content is zoomed past.
    // (Checked one position in, not at the section's own boundary: that
    // boundary coincides with the end of the ancestor's now-hidden
    // paragraph, so a boundary-overlap check there would false-positive.)
    const a1Pos = aParagraphPos + aParagraph.nodeSize;
    const a1HeadingClasses = classesAt(decorations, a1Pos + 1);
    expect(a1HeadingClasses).not.toContain("doc-root-hidden");
    expect(a1HeadingClasses).toContain("doc-root-level-1");
  });

  it("with no root, nothing is hidden and nothing is level-relabeled", () => {
    const doc = schema.node("doc", null, [section("a", 1, "Alpha"), section("b", 2, "Beta")]);
    const decorations = buildDecorations(doc, null);
    const classes = decorations
      .find()
      .flatMap((d) => (d as unknown as { type: { attrs?: { class?: string } } }).type.attrs?.class?.split(" ") ?? []);
    expect(classes).not.toContain("doc-root-hidden");
    expect(classes.filter((c) => c.startsWith("doc-root-level-"))).toHaveLength(0);
  });
});
