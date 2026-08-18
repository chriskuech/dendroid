// TipTap, bound to the *whole* document via loro-prosemirror's default
// binding (no containerId — `doc.getMap("doc")`). One instance, mounted
// once per workspace, never remounted per heading: cursor, selection, and
// backspace all flow naturally across what used to be per-node container
// boundaries, because it's just one ProseMirror document. See
// `dendroid_core::outline` for why headings can still be addressed
// individually (the tree view, `@`-links) despite there being no
// per-heading container anymore — and `ux/editor/tiptap/section.ts`/
// `sectionStructure.ts` for how a heading's whole subtree (not just the
// heading itself) ends up as one such container: `DocumentWithSections`
// replaces StarterKit's own `content: "block+"` document with
// `"section+"`, and `SectionStructure` is what keeps typing `#`/`##`/`###`
// producing correctly *nested* sections rather than flat siblings.

import { forwardRef, useImperativeHandle, useMemo, useRef, type KeyboardEvent } from "react";
import { EditorContent, useEditor, type Editor as TiptapEditor } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Heading from "@tiptap/extension-heading";
import Placeholder from "@tiptap/extension-placeholder";
import { keymap } from "@tiptap/pm/keymap";
import { LoroSyncPlugin, LoroUndoPlugin, redo, undo, type LoroDocType } from "loro-prosemirror";
import { DocumentWithSections, Section } from "./tiptap/section";
import { SectionStructure } from "./tiptap/sectionStructure";
import { HeadingFold } from "./tiptap/headingFold";
import { DocRoot } from "./tiptap/docRoot";
import { LinkRef } from "./tiptap/linkRef";
import type { DendroidDocument } from "../../lib/crdt/document";
import { playTypewriterClick } from "./typewriterSound";

// Modifier keys held on their own (no character/action yet) shouldn't
// click — only the keystroke that actually does something should.
const SILENT_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

export interface EditorHandle {
  editor: TiptapEditor | null;
}

interface EditorProps {
  crdt: DendroidDocument;
  /** Headings at or past this outline depth start collapsed the first
   * time the doc loads with content — mirrors `AppSettings.descendantDepth`
   * (see headingFold.ts). Read once at mount, same as every other TipTap
   * extension option here: `useEditor` never reconfigures after the first
   * render, so a later settings change doesn't retroactively refold. */
  initialExpandedDepth: number;
  /** Mirrors the editor's own fold state out to the tree view — fires for
   * both clicks on the editor's chevrons and `toggleHeadingFold` calls the
   * tree view makes back in. */
  onFoldChange: (collapsed: ReadonlySet<string>) => void;
  /** Mirrors the editor's current root out to the tree view — fires for
   * both clicks on a heading's reroot toggle and `toggleDocumentRoot` calls
   * the tree view makes back in. */
  onRootChange: (rootId: string | null) => void;
  /** Mirrors the `@`-link plugin's expanded-link-id set out to the tree
   * view — same shape as `onFoldChange`. */
  onLinkExpandChange: (expanded: ReadonlySet<string>) => void;
  /** Jumps the real editor to heading `id` — what both a click on an
   * `@`-link chip and a click on a row inside its expanded preview call
   * (read-only, click-to-jump; see `ux/editor/tiptap/linkRef.ts`). Reuses
   * `Workspace.tsx`'s existing heading-select/scroll logic. */
  onNavigateLink: (id: string) => void;
  /** Whether the cursor is currently in the editor — drives zen mode's
   * chrome-fade idle countdown (see `lib/useZenChrome.ts`). Optional since
   * not every mount (e.g. a future preview/readonly embed) needs it. */
  onFocusChange?: (focused: boolean) => void;
  /** Mirrors `AppSettings.auralFeedback` (Settings > Editor > Aural
   * Feedback) — plays a soft typewriter click on every keypress while
   * true. Defaults to off, matching the setting's default. */
  auralFeedback?: boolean;
}

export const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(
  { crdt, initialExpandedDepth, onFoldChange, onRootChange, onLinkExpandChange, onNavigateLink, onFocusChange, auralFeedback },
  ref,
) {
  // loro-prosemirror's types assume the doc-shaped generic it uses
  // internally for its own default root containers; `LoroDoc` itself
  // isn't actually specialized by that generic, so this is a type-level-
  // only mismatch, not a runtime one.
  const loroDoc = crdt.doc as unknown as LoroDocType;

  const loroExtension = useMemo(
    () =>
      Extension.create({
        name: "loro",
        addProseMirrorPlugins() {
          return [
            LoroSyncPlugin({ doc: loroDoc }),
            LoroUndoPlugin({ doc: loroDoc }),
            keymap({
              "Mod-z": undo,
              "Mod-y": redo,
              "Mod-Shift-z": redo,
            }),
          ];
        },
      }),
    [loroDoc],
  );

  // `useEditor` builds its extensions once, at mount, and never
  // reconfigures them — so `onFoldChange` is routed through a ref instead
  // of being closed over directly, to keep calling whatever the latest
  // Workspace callback is even though the extension instance itself never
  // changes.
  const onFoldChangeRef = useRef(onFoldChange);
  onFoldChangeRef.current = onFoldChange;

  const headingFoldExtension = useMemo(
    () =>
      HeadingFold.configure({
        initialExpandedDepth,
        onChange: (collapsed) => onFoldChangeRef.current(collapsed),
      }),
    [initialExpandedDepth],
  );

  const onRootChangeRef = useRef(onRootChange);
  onRootChangeRef.current = onRootChange;

  const docRootExtension = useMemo(
    () => DocRoot.configure({ onChange: (rootId) => onRootChangeRef.current(rootId) }),
    [],
  );

  const onLinkExpandChangeRef = useRef(onLinkExpandChange);
  onLinkExpandChangeRef.current = onLinkExpandChange;
  const onNavigateLinkRef = useRef(onNavigateLink);
  onNavigateLinkRef.current = onNavigateLink;

  const linkRefExtension = useMemo(
    () =>
      LinkRef.configure({
        // `crdt.snapshotOutline()` reads straight off the live Loro
        // mirror on every call — no need to route this through a ref the
        // way the callback props above are, since `crdt` itself is stable
        // for this editor's whole lifetime. Same for `doc`/`getContainerId`
        // below — what lets an expanded link mount a genuinely live nested
        // editor (`ux/editor/tiptap/embeddedEditor.ts`) instead of a rebuilt-DOM
        // snapshot; see `linkRef.ts`'s header comment.
        getOutline: () => crdt.snapshotOutline(),
        previewDepth: initialExpandedDepth,
        onNavigate: (id) => onNavigateLinkRef.current(id),
        onExpandChange: (expanded) => onLinkExpandChangeRef.current(expanded),
        doc: loroDoc,
        getContainerId: (id) => crdt.getSectionContainerId(id),
      }),
    [crdt, initialExpandedDepth, loroDoc],
  );

  const editor = useEditor({
    extensions: [
      // Loro's own undo manager replaces StarterKit's local history;
      // `document` is replaced by `DocumentWithSections` (content
      // `"section+"` instead of `"block+"`) so every top-level node is a
      // section wrapping its own heading + body — see this file's header
      // comment.
      StarterKit.configure({ undoRedo: false, document: false }),
      DocumentWithSections,
      Section,
      Heading,
      // Must come before headingFold/docRoot/linkRef in this list so a
      // freshly-typed heading is already correctly nested (and has an id)
      // by the time their own decorations read the doc on the same
      // settle cycle — though since every one of these is itself an
      // `appendTransaction` plugin, ProseMirror re-runs the whole set
      // again on any round that changes anything, so strict ordering only
      // affects how many of those rounds it takes, not correctness (see
      // `sectionStructure.ts`'s header comment).
      SectionStructure,
      headingFoldExtension,
      docRootExtension,
      linkRefExtension,
      Placeholder.configure({
        placeholder: ({ node }) => (node.type.name === "heading" ? "Untitled" : "Write…"),
      }),
      loroExtension,
    ],
    // Top-level callbacks (unlike extension config above) stay live across
    // re-renders, so this can close over the latest `onFocusChange` prop
    // directly rather than needing the ref indirection the extensions use.
    onFocus: () => onFocusChange?.(true),
    onBlur: () => onFocusChange?.(false),
  });

  useImperativeHandle(ref, () => ({ editor }), [editor]);

  function handleKeyDownCapture(e: KeyboardEvent) {
    if (!auralFeedback || e.nativeEvent.isComposing || SILENT_KEYS.has(e.key)) return;
    playTypewriterClick();
  }

  return <EditorContent editor={editor} className="doc-editor" onKeyDownCapture={handleKeyDownCapture} />;
});
