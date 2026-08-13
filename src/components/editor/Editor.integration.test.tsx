// End-to-end coverage for the editor's own "infinite expansion" guard:
// expanding an `@`-link mounts a genuinely live nested editor
// (`lib/tiptap/embeddedEditor.ts`), and *that* editor's own `LinkRef` is
// configured with `allowExpand: false` specifically so an `@`-link cycle
// (A embeds B, B embeds A) can't recursively mount live editors forever
// (see `linkRef.ts`'s and `embeddedEditor.ts`'s header comments). This
// mounts two real, cyclically-linked headings through the actual `Editor`
// component, a real (backend-less, in-memory) `DendroidDocument`, and a
// real Loro sync — `linkRef.test.ts` covers the same guard at the unit
// level, directly against `buildDecorations`.

import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JSONContent } from "@tiptap/core";
import { Editor, type EditorHandle } from "./Editor";
import { DendroidDocument } from "../../lib/crdt/document";

/** Two headings, each linking to the other — the minimal `@`-link cycle. */
function cyclicContent(): JSONContent {
  return {
    type: "doc",
    content: [
      {
        type: "section",
        attrs: { id: "secA" },
        content: [
          { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Alpha" }] },
          {
            type: "paragraph",
            content: [{ type: "text", text: "See " }, { type: "linkRef", attrs: { id: "linkA2B", targetId: "secB", staleTitle: null } }],
          },
        ],
      },
      {
        type: "section",
        attrs: { id: "secB" },
        content: [
          { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Beta" }] },
          {
            type: "paragraph",
            content: [{ type: "text", text: "See " }, { type: "linkRef", attrs: { id: "linkB2A", targetId: "secA", staleTitle: null } }],
          },
        ],
      },
    ],
  };
}

function Harness({ handle }: { handle: React.RefObject<EditorHandle | null> }) {
  const crdtRef = useRef<DendroidDocument | null>(null);
  if (!crdtRef.current) crdtRef.current = new DendroidDocument();

  return (
    <Editor
      ref={handle}
      crdt={crdtRef.current}
      initialExpandedDepth={3}
      onFoldChange={() => {}}
      onRootChange={() => {}}
      onLinkExpandChange={() => {}}
      onNavigateLink={() => {}}
    />
  );
}

async function mountReadyEditor() {
  const handle = { current: null } as React.RefObject<EditorHandle | null>;
  const utils = render(<Harness handle={handle} />);
  await waitFor(() => expect(handle.current?.editor).toBeTruthy());
  const editor = handle.current!.editor!;
  editor.commands.setContent(cyclicContent());
  await waitFor(() => expect(editor.state.doc.textContent).toContain("Alpha"));
  return { ...utils, editor };
}

describe("Editor — @-link cycle can't recursively mount live editors", () => {
  it("expanding A's link to B mounts one live embedded editor, whose own link back to A is chip-only (not expandable)", async () => {
    const user = userEvent.setup();
    const { container, editor } = await mountReadyEditor();

    // Expand A's link to B.
    editor.commands.toggleLinkExpand("linkA2B");
    await waitFor(() => expect(container.querySelector(".link-ref-preview")).toBeTruthy());

    // Exactly one live embedded editor mounted, for B's own content.
    const embeds = container.querySelectorAll(".link-ref-preview__embed");
    expect(embeds).toHaveLength(1);
    await waitFor(() => expect(embeds[0].textContent).toContain("Beta"));

    // Inside that embed, the chip for B's own link back to A is rendered
    // (a link inside an embedded section still shows and still jumps on
    // click) but its toggle is the non-foldable, empty variant — clicking
    // it can't expand a second level, which is exactly the mechanism that
    // stops the cycle from recursing.
    const nestedToggle = embeds[0].querySelector(".link-ref-toggle");
    expect(nestedToggle).toBeTruthy();
    expect(nestedToggle).toHaveClass("link-ref-toggle--empty");
    expect(nestedToggle).not.toHaveClass("is-expanded");

    // Clicking it anyway (e.g. a stray click makes it through) must not
    // mount a second, nested live editor — still exactly one embed in the
    // whole tree afterward.
    await user.click(nestedToggle!);
    expect(container.querySelectorAll(".link-ref-preview__embed")).toHaveLength(1);
    expect(container.querySelectorAll(".link-ref-preview")).toHaveLength(1);
  });

  it("collapsing the link back down unmounts the embedded editor", async () => {
    const { container, editor } = await mountReadyEditor();

    editor.commands.toggleLinkExpand("linkA2B");
    await waitFor(() => expect(container.querySelector(".link-ref-preview__embed")).toBeTruthy());

    editor.commands.toggleLinkExpand("linkA2B");
    await waitFor(() => expect(container.querySelector(".link-ref-preview")).toBeNull());
  });

  it("the top-level editor's own links stay expandable (only the embedded level is capped)", async () => {
    const { container, editor } = await mountReadyEditor();

    const topToggle = container.querySelector(".link-ref-toggle");
    expect(topToggle).toBeTruthy();
    expect(topToggle).not.toHaveClass("link-ref-toggle--empty");

    editor.commands.toggleLinkExpand("linkA2B");
    await waitFor(() => expect(container.querySelector(".link-ref-preview")).toBeTruthy());
  });
});
