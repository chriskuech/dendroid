// Vitest port of `scripts/verify-section-structure.ts`'s headless,
// DOM-free scenarios, plus a termination/idempotency check aimed
// specifically at the "runaway empty sections" failure mode that file's
// own history and header comment call out (an off-by-one in
// `findPromotable`'s position math used to produce it). `settle` here
// mirrors the real `appendTransaction` plugin's own multi-round loop
// (`SectionStructure`'s `addProseMirrorPlugins`) exactly, just driven from
// a plain `Transform` instead of a live `EditorView`.

import { describe, expect, it } from "vitest";
import { Schema } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { applyFix, findMisplacedHeading, findPromotable, levelOf, type StructuralFix } from "./sectionStructure";

const schema = new Schema({
  nodes: {
    doc: { content: "section+" },
    section: { content: "heading (heading | block)*", group: "block section" },
    heading: { content: "inline*", group: "block", attrs: { level: { default: 1 } } },
    paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" },
  },
});

function h(level: number, text = "") {
  return schema.nodes.heading.create({ level }, text ? schema.text(text) : undefined);
}
function p(text = "") {
  return schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
}
function section(...content: unknown[]) {
  return schema.nodes.section.create(null, content as never);
}
function doc(...content: unknown[]) {
  return schema.node("doc", null, content as never);
}

/** Runs demote/promote to convergence exactly like the real plugin's
 * multi-round `appendTransaction` loop — a hard `maxRounds` ceiling stands
 * in for "this must actually terminate": a genuine convergence bug (the
 * "runaway empty sections" failure this file's own history hit) shows up
 * here as `rounds === maxRounds` rather than a hung test process. */
function settle(input: ReturnType<typeof doc>, maxRounds = 50): { doc: typeof input; rounds: number } {
  let current = input;
  let rounds = 0;
  while (rounds < maxRounds) {
    const fix: StructuralFix | null = findMisplacedHeading(current) ?? findPromotable(current);
    if (!fix) break;
    const tr = new Transform(current);
    applyFix(tr as never, fix);
    current = tr.doc as typeof input;
    rounds++;
  }
  return { doc: current, rounds };
}

function outline(root: ReturnType<typeof doc>): string {
  const lines: string[] = [];
  function walk(node: ReturnType<typeof doc>, depth: number) {
    node.forEach((child) => {
      if (child.type.name !== "section") return;
      const heading = child.firstChild;
      const level = heading?.attrs.level ?? "?";
      const title = heading?.textContent ?? "";
      const bodyKinds: string[] = [];
      for (let i = 1; i < child.childCount; i++) {
        bodyKinds.push(child.child(i).type.name === "section" ? "<section>" : child.child(i).type.name);
      }
      lines.push(`${"  ".repeat(depth)}L${level} "${title}" body=[${bodyKinds.join(",")}]`);
      walk(child as never, depth + 1);
    });
  }
  walk(root, 0);
  return lines.join("\n");
}

describe("SectionStructure demote/promote convergence", () => {
  it("leaves an already well-formed doc untouched (0 rounds)", () => {
    const { doc: settled, rounds } = settle(doc(section(h(1, "Intro"), p("body"), section(h(2, "Sub"), p("nested")))));
    expect(rounds).toBe(0);
    expect(outline(settled)).toBe('L1 "Intro" body=[paragraph,<section>]\n  L2 "Sub" body=[paragraph]');
  });

  it("demotes a bare deeper heading typed mid-body into its own nested section", () => {
    const { doc: settled } = settle(doc(section(h(1, "Intro"), p("body"), h(2, "Sub"), p("nested"))));
    settled.check();
    expect(outline(settled)).toBe('L1 "Intro" body=[paragraph,<section>]\n  L2 "Sub" body=[paragraph]');
  });

  it("promotes a shallower heading typed deep inside a nested section all the way back out to the top", () => {
    const { doc: settled } = settle(
      doc(
        section(h(1, "Root"), section(h(2, "Middle"), section(h(3, "Leaf"), p("leaf body"), h(1, "NewRoot"), p("new root body")))),
      ),
    );
    settled.check();
    expect(outline(settled)).toBe(
      ['L1 "Root" body=[<section>]', '  L2 "Middle" body=[<section>]', '    L3 "Leaf" body=[paragraph]', 'L1 "NewRoot" body=[paragraph]'].join(
        "\n",
      ),
    );
  });

  it("a same-level heading becomes a sibling, not a child, of the open ancestor it closes", () => {
    const { doc: settled } = settle(doc(section(h(1, "Root"), section(h(2, "A"), p("a body")), h(2, "B"), p("b body"))));
    settled.check();
    expect(outline(settled)).toBe(
      ['L1 "Root" body=[<section>,<section>]', '  L2 "A" body=[paragraph]', '  L2 "B" body=[paragraph]'].join("\n"),
    );
  });

  it("multiple independent misplaced headings in one doc all converge together", () => {
    const { doc: settled } = settle(
      doc(
        section(h(1, "A"), p("a"), h(2, "A1"), p("a1"), h(2, "A2"), p("a2")),
        section(h(1, "B"), h(3, "B-deep"), p("b-deep")),
      ),
    );
    settled.check();
    expect(outline(settled)).toBe(
      [
        'L1 "A" body=[paragraph,<section>,<section>]',
        '  L2 "A1" body=[paragraph]',
        '  L2 "A2" body=[paragraph]',
        'L1 "B" body=[<section>]',
        '  L3 "B-deep" body=[paragraph]',
      ].join("\n"),
    );
  });

  it("is idempotent — settling an already-settled doc a second time is a true no-op", () => {
    const once = settle(
      doc(section(h(1, "A"), p("a"), h(2, "A1"), p("a1"), h(2, "A2"), p("a2")), section(h(1, "B"), h(3, "B-deep"), p("b-deep"))),
    ).doc;
    const twice = settle(once);
    expect(twice.rounds).toBe(0);
    expect(twice.doc.eq(once)).toBe(true);
  });

  it("a heading typed many levels deep converges within a small, bounded number of rounds — not the runaway-empty-sections failure mode", () => {
    // Nest 10 sections deep, then drop a level-1 heading at the very
    // bottom — this is exactly the shape that used to trigger the
    // off-by-one this file's header comment describes (climbing back out
    // past every open ancestor, one promote per level).
    let innermost = section(h(10, "Deep"), p("deep body"), h(1, "Root"), p("new root body"));
    for (let level = 9; level >= 1; level--) innermost = section(h(level, `L${level}`), innermost);
    const { doc: settled, rounds } = settle(doc(innermost));

    settled.check();
    expect(rounds).toBeLessThan(50); // did not hit the maxRounds ceiling
    expect(rounds).toBeGreaterThan(0);
    // The promoted heading must land back at the top level, as its own
    // section — not stranded, duplicated, or dropped along the way.
    let sawNewRootAtTop = false;
    settled.forEach((child) => {
      if (child.firstChild?.textContent === "Root") sawNewRootAtTop = true;
    });
    expect(sawNewRootAtTop).toBe(true);
  });
});

describe("levelOf", () => {
  it("reads a bare heading's own level", () => {
    expect(levelOf(h(2, "x"))).toBe(2);
  });

  it("reads a section's level via its leading heading", () => {
    expect(levelOf(section(h(3, "x"), p()))).toBe(3);
  });

  it("returns null for anything else", () => {
    expect(levelOf(p("x"))).toBeNull();
  });
});
