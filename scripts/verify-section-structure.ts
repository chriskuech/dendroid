// Headless, DOM-free sanity check for ../src/lib/tiptap/sectionStructure.ts's
// demote/promote convergence — runs entirely against prosemirror-model /
// prosemirror-transform (no EditorView, no jsdom needed). Run with:
//   bun run scripts/verify-section-structure.ts
// from the repo root. This is what caught the off-by-one in
// `findPromotable`'s position math (fixed) — see that file's own "KNOWN
// BUG" note for a *different*, still-open issue this script's own
// EditorView-free design means it can't catch (a real `EditorView`'s
// DOM/selection resync, not this logic, is where that one lives).

import { Schema } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { findMisplacedHeading, findPromotable, applyFix } from "../src/lib/tiptap/sectionStructure.ts";

const schema = new Schema({
  nodes: {
    doc: { content: "section+" },
    section: { content: "heading (heading | block)*", group: "block section" },
    heading: { content: "inline*", group: "block", attrs: { level: { default: 1 } } },
    paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" },
  },
});

function h(level: number, text: string) {
  return schema.nodes.heading.create({ level }, text ? schema.text(text) : undefined);
}
function p(text: string) {
  return schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
}
function section(...content: any[]) {
  return schema.nodes.section.create(null, content);
}

/** Runs demote/promote to convergence, exactly like the real
 * appendTransaction plugin's multi-round loop, and returns the settled
 * doc plus how many rounds it took. */
function settle(doc: any, maxRounds = 50): { doc: any; rounds: number } {
  let rounds = 0;
  while (rounds < maxRounds) {
    const fix = findMisplacedHeading(doc) ?? findPromotable(doc);
    if (!fix) break;
    const tr = new Transform(doc);
    // applyFix expects a prosemirror-state Transaction, but only uses
    // .doc/.replaceWith/.delete/.insert/.mapping — all present on the
    // plain Transform base class too, so this is a faithful stand-in.
    applyFix(tr as any, fix);
    doc = tr.doc;
    rounds++;
  }
  return { doc, rounds };
}

function outline(doc: any): string {
  const lines: string[] = [];
  function walk(node: any, depth: number) {
    node.forEach((child: any) => {
      if (child.type.name !== "section") return;
      const heading = child.firstChild;
      const level = heading?.attrs.level ?? "?";
      const title = heading?.textContent ?? "";
      const bodyKinds = [];
      for (let i = 1; i < child.childCount; i++) bodyKinds.push(child.child(i).type.name === "section" ? "<section>" : child.child(i).type.name);
      lines.push(`${"  ".repeat(depth)}L${level} "${title}" body=[${bodyKinds.join(",")}]`);
      walk(child, depth + 1);
    });
  }
  walk(doc, 0);
  return lines.join("\n");
}

let pass = 0;
let fail = 0;
function check(name: string, doc: any, expected: string) {
  const { doc: settled, rounds } = settle(doc);
  settled.check(); // throws if the resulting doc is ever schema-invalid
  const actual = outline(settled);
  const ok = actual.trim() === expected.trim();
  console.log(`${ok ? "PASS" : "FAIL"} — ${name} (${rounds} round${rounds === 1 ? "" : "s"})`);
  if (!ok) {
    console.log("  expected:\n" + expected.trim().split("\n").map((l) => "    " + l).join("\n"));
    console.log("  actual:\n" + actual.trim().split("\n").map((l) => "    " + l).join("\n"));
  }
  ok ? pass++ : fail++;
}

// 1. Already well-formed doc: zero rounds needed, nothing changes.
check(
  "already well-formed, no-op",
  schema.node("doc", null, [section(h(1, "Intro"), p("body"), section(h(2, "Sub"), p("nested")))]),
  `
L1 "Intro" body=[paragraph,<section>]
  L2 "Sub" body=[paragraph]
`,
);

// 2. Demote: a bare heading mid-body (simulating the input rule's
// in-place setBlockType) becomes its own nested child section.
check(
  "demote: deeper heading typed after body text",
  schema.node("doc", null, [section(h(1, "Intro"), p("body"), h(2, "Sub"), p("nested"))]),
  `
L1 "Intro" body=[paragraph,<section>]
  L2 "Sub" body=[paragraph]
`,
);

// 3. Demote + promote: a level-1 heading typed deep inside a level-3
// section's body must climb all the way back out to the top level,
// closing every open ancestor along the way — same as the old flat
// model's "pop the stack until level constraint satisfied".
check(
  "promote: shallower heading typed deep inside a nested section",
  schema.node("doc", null, [
    section(
      h(1, "Root"),
      section(h(2, "Middle"), section(h(3, "Leaf"), p("leaf body"), h(1, "NewRoot"), p("new root body"))),
    ),
  ]),
  `
L1 "Root" body=[<section>]
  L2 "Middle" body=[<section>]
    L3 "Leaf" body=[paragraph]
L1 "NewRoot" body=[paragraph]
`,
);

// 4. Same level as an open ancestor closes it (doesn't nest under it) —
// e.g. a second level-2 heading after an existing level-2 section closes
// that one and becomes level-1's next child, not level-2's child.
check(
  "same-level heading becomes a sibling, not a child",
  schema.node("doc", null, [section(h(1, "Root"), section(h(2, "A"), p("a body")), h(2, "B"), p("b body"))]),
  `
L1 "Root" body=[<section>,<section>]
  L2 "A" body=[paragraph]
  L2 "B" body=[paragraph]
`,
);

// 5. Multiple independent misplaced headings in one doc all converge.
check(
  "multiple misplaced headings converge together",
  schema.node("doc", null, [
    section(h(1, "A"), p("a"), h(2, "A1"), p("a1"), h(2, "A2"), p("a2")),
    section(h(1, "B"), h(3, "B-deep"), p("b-deep")),
  ]),
  `
L1 "A" body=[paragraph,<section>,<section>]
  L2 "A1" body=[paragraph]
  L2 "A2" body=[paragraph]
L1 "B" body=[<section>]
  L3 "B-deep" body=[paragraph]
`,
);

// 6. Idempotency: settling an already-settled doc a second time is a
// true no-op (0 rounds, byte-identical doc) — a convergence loop that
// "settles" onto a still-fixable state would be a real bug.
{
  const once = settle(
    schema.node("doc", null, [
      section(h(1, "A"), p("a"), h(2, "A1"), p("a1"), h(2, "A2"), p("a2")),
      section(h(1, "B"), h(3, "B-deep"), p("b-deep")),
    ]),
  ).doc;
  const twice = settle(once);
  const ok = twice.rounds === 0 && twice.doc.eq(once);
  console.log(`${ok ? "PASS" : "FAIL"} — idempotency: settling twice changes nothing further`);
  ok ? pass++ : fail++;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
