// A live, read-write TipTap instance bound to one section's own Loro
// container (a section's whole subtree — heading, body, nested
// subsections — lives inside that one container; see `section.ts`'s and
// `dendroid_core::outline`'s doc comments for why). What `linkRef.ts`
// mounts inside an expanded `@`-link's preview, replacing the old
// rebuilt-DOM snapshot that could never live-update in place.
//
// Doesn't use `loro-prosemirror`'s own `LoroSyncPlugin({ containerId })` —
// that plugin always diffs/writes `editorState.doc` (the *whole* nested
// editor's top-level document) as a single unit against the bound
// container, and on read always reconstructs the container's content as
// the *child* of whatever the schema's topNodeType already is
// (`sync-plugin.ts`'s `init()`: `tr.replace(0, size,
// Slice(Fragment.from(node)))` — a content-range replace, which can never
// change what node type occupies the top). Both of those are fine for the
// library's own intended use (a *fresh*, editor-owned root container — see
// its README's `doc.getMap("<unique-id-per-editor-instance>")` example),
// but contradict each other for a container that's *already* shaped like
// a nested `section` (created by the outer editor's schema): satisfying
// the write side's `editorState.doc.type.name === storedNodeName` check
// requires this editor's own topNodeType to be named "section"
// (`EmbeddedSectionRoot`, see `section.ts`), but the read side would then
// insert the reconstructed section as *that same type's own child* —
// which a real section's content expression (heading-first) can never
// validly contain.
//
// So this hand-rolls the same two primitives `loro-prosemirror` itself
// exports, applied at the right level instead of the whole document:
//  - `createNodeFromLoroObj(schema, container, mapping)` builds the
//    node — used to seed the editor's *initial* `doc` directly (so
//    `editorState.doc` genuinely *is* the section, not a wrapper around
//    it) and again on every subsequent remote Loro event, splicing the
//    freshly-read node's own *content* into the existing `doc` (keeping
//    `doc`'s own identity/attrs — its id — stable; only what's nested
//    inside gets refreshed).
//  - `updateLoroToPmState(doc, mapping, editorState, containerId)` — the
//    write side — works unmodified, because `editorState.doc.type.name`
//    genuinely is `"section"` here, matching what's stored.
//
// Deliberately excludes, on purpose, not by oversight:
//  - `LoroUndoPlugin`/its undo keymap — `UndoManager` is doc-scoped, not
//    container-scoped (no such option in `loro-crdt`'s own types), so a
//    second instance here would double-track the same doc's commits
//    rather than meaningfully scoping itself to just this container.
//  - `DocRoot` — "scope the editor to one heading's subtree" doesn't mean
//    anything inside a view that's already scoped to exactly one section.
//  - Further live-embedding of its own `@`-links (`LinkRef`'s
//    `allowExpand: false`, see that file) — without this, an `@`-link
//    cycle (A embeds B, B embeds A) would recursively mount live editors
//    forever. Links inside an embedded section stay visible and
//    click-to-jump; they just can't expand a level deeper.
//
// KNOWN LIMITATION, not yet fixed: Ctrl-Z on the *outer* editor does not
// undo an edit made through an embedded one, even though both write into
// the same shared `LoroDoc` — verified interactively (edit via the embed,
// Ctrl-Z on the outer editor, the edit is still there), together with a
// `console.error("Cannot find the loroNode")` from `loro-prosemirror`'s
// own cursor bookkeeping (`cursor/common.ts`) each time, thrown while the
// outer editor's `LoroUndoPlugin` tries to resolve a cursor position for
// a commit it's tracking that didn't actually originate from *its own*
// sync path. Content itself is never corrupted by this — the embed's
// write lands and syncs correctly either way, this is purely about the
// outer editor's undo stack not fully "seeing" a commit this plugin made
// through `updateLoroToPmState` directly rather than through
// `LoroSyncPlugin`'s own tracked flow. Typing continues to work
// normally afterward in both editors. Whoever picks this up next should
// look at what `LoroUndoPlugin` actually keys its tracking on (peer id?
// origin string? the specific `LoroSyncPlugin` instance's own state?) —
// `updateLoroToPmState` here commits with `origin: "loroSyncPlugin"`,
// same as the real plugin, so the gap is likely something more specific
// than the commit's own origin tag.

import { Editor, Extension, getSchema } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Slice } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import Heading from "@tiptap/extension-heading";
import { createNodeFromLoroObj, updateLoroToPmState, type LoroDocType, type LoroNodeMapping, type LoroNode } from "loro-prosemirror";
import type { ContainerID } from "loro-crdt";
import { EmbeddedSectionRoot, Section } from "./section";
import { SectionStructure } from "./sectionStructure";
import { HeadingFold } from "./headingFold";
import { LinkRef } from "./linkRef";
import type { HeadingDto } from "../../../lib/crdt/outline";

export interface EmbeddedEditorOptions {
  /** Where to mount — TipTap appends its own `.ProseMirror` element as a
   * child of this (see `@tiptap/core`'s `element` option: "the editor
   * will be mounted appended to that element"). Caller owns teardown
   * (`destroy()` on the returned editor) — see `linkRef.ts`'s widget
   * `spec.destroy`. */
  element: HTMLElement;
  doc: LoroDocType;
  containerId: ContainerID;
  getOutline: () => HeadingDto[];
  previewDepth: number;
  onNavigate: (id: string) => void;
}

const embeddedSyncPluginKey = new PluginKey<{ mapping: LoroNodeMapping }>("embeddedSectionSync");

/** Marks a transaction this plugin dispatched itself (reflecting a remote
 * Loro event into the PM doc) so `appendTransaction` doesn't turn around
 * and write that same, already-current data straight back to Loro — not
 * wrong (the diff would just find nothing new), only wasteful. */
const REMOTE_META = "remote";

function embeddedSyncPlugin(doc: LoroDocType, containerId: ContainerID): Plugin {
  // Whether *this plugin instance* is, right now, synchronously inside its
  // own `updateLoroToPmState` write call — set/cleared around that call
  // below, and checked in the Loro subscription to skip re-reading a
  // change this same instance just made. Deliberately not `event.by ===
  // "local"` (what `loro-prosemirror`'s own `LoroSyncPlugin` checks): that
  // distinguishes *local vs. imported/checked-out*, not *this editor vs.
  // some other one* — the outer editor's own edits to this same container
  // are *also* "local" (they're a local transaction on the same shared
  // `LoroDoc`), so that check would just as happily swallow genuinely
  // external edits this instance needs to pick up. Verified against a
  // real edit made through the *outer* editor while this container's
  // preview was expanded — with `event.by === "local"` alone, it silently
  // never synced; this flag is what actually distinguishes the two.
  let writingLocally = false;

  return new Plugin({
    key: embeddedSyncPluginKey,

    state: {
      init: (): { mapping: LoroNodeMapping } => ({ mapping: new Map() }),
      apply: (_tr, value) => value,
    },

    appendTransaction(transactions, _oldState, newState) {
      if (transactions.some((tr) => tr.getMeta(embeddedSyncPluginKey) === REMOTE_META)) return null;
      if (!transactions.some((tr) => tr.docChanged)) return null;

      const { mapping } = embeddedSyncPluginKey.getState(newState)!;
      writingLocally = true;
      try {
        updateLoroToPmState(doc, mapping, newState, containerId);
      } finally {
        writingLocally = false;
      }
      return null;
    },

    view(view) {
      const container = doc.getContainerById(containerId) as LoroNode;

      const unsubscribe = container.subscribe(() => {
        if (view.isDestroyed || writingLocally) return;

        // A fresh `mapping` per read (rather than the write side's own,
        // persistent one in plugin state) — simpler, at the cost of the
        // library's own "reuse identical unchanged node objects" identity
        // optimization across remote updates; correctness doesn't depend
        // on it (`WEAK_NODE_TO_LORO_CONTAINER_MAPPING`, which the write
        // side's diffing actually relies on, gets populated by
        // `createNodeFromLoroObj` itself regardless of which `mapping`
        // instance is passed in).
        const node = createNodeFromLoroObj(view.state.schema, container, new Map());
        const tr = view.state.tr
          .replace(0, view.state.doc.content.size, new Slice(node.content, 0, 0))
          .setMeta(embeddedSyncPluginKey, REMOTE_META);
        view.dispatch(tr);
      });

      return { destroy: () => unsubscribe() };
    },
  });
}

export function mountEmbeddedEditor(opts: EmbeddedEditorOptions): Editor {
  const extensions = [
    StarterKit.configure({ undoRedo: false, document: false }),
    EmbeddedSectionRoot,
    Section,
    Heading,
    SectionStructure,
    HeadingFold.configure({ initialExpandedDepth: opts.previewDepth }),
    LinkRef.configure({
      getOutline: opts.getOutline,
      previewDepth: opts.previewDepth,
      onNavigate: opts.onNavigate,
      allowExpand: false,
    }),
  ];

  // Built once, up front, so the editor's *initial* `doc` can be the real
  // section data from the very first paint — `getSchema` is the same
  // utility `Editor`'s own constructor uses internally to build a schema
  // from an extension list, so this is guaranteed structurally identical
  // to what the `Editor` below builds for itself.
  const schema = getSchema(extensions);
  const container = opts.doc.getContainerById(opts.containerId) as LoroNode;
  const initialNode = createNodeFromLoroObj(schema, container, new Map());

  // Same idiom as `Editor.tsx`'s own `loroExtension` — a one-off
  // `Extension.create` closing over this call's own `doc`/`containerId`
  // rather than a shared, reusable extension export.
  const syncExtension = Extension.create({
    name: "embeddedSectionSync",
    addProseMirrorPlugins() {
      return [embeddedSyncPlugin(opts.doc, opts.containerId)];
    },
  });

  return new Editor({
    element: opts.element,
    extensions: [...extensions, syncExtension],
    content: initialNode.toJSON(),
  });
}
