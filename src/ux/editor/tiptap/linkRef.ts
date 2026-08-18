// `@`-links: an inline atom node (typed mid-sentence, like a mention —
// see the whitepaper's "`@`-link to any heading in the app") that always
// addresses its target by the heading's stable id (see `section.ts`),
// never by title, so a rename never breaks it — `dendroid_core::links`
// (backlink reconciliation) is what keeps `targetId` valid across a
// *deletion* instead.
//
// Same idiom as `headingFold.ts`/`docRoot.ts`: the node's own `toDOM` is an
// empty shell, and a companion plugin supplies everything visible —
// the "@ Title" chip, its expand/collapse chevron, and (when expanded) a
// read-only, depth-limited preview of the target's subtree — as widget
// decorations rebuilt from the live document on every state change. That
// keeps a rename or a reconciliation rewrite reflected immediately, with
// no separate subscription to keep in sync.
//
// When expanded, and the target's own section has a resolvable Loro
// container (`getContainerId` — every section does, once migration/
// `SectionStructure` has run; see `dendroid_core::outline`'s doc comment
// for why a section's whole subtree is one container), the preview is a
// genuinely live, editable nested editor (`embeddedEditor.ts`) bound to
// that same container — typing there edits the actual section, and an
// edit made anywhere else to that section shows up here too. That editor
// hand-rolls its own sync against two of `loro-prosemirror`'s exported
// primitives (`createNodeFromLoroObj`/`updateLoroToPmState`) rather than
// reusing its packaged `LoroSyncPlugin({ containerId })` — see
// `embeddedEditor.ts`'s header comment for exactly why that plugin's own
// binding doesn't fit an *already-nested* container. Falls back to the
// old read-only, click-to-jump, rebuilt-DOM preview
// (`buildStaticPreview`) when no container id resolves (a stale/orphaned
// link, or one racing a deletion that hasn't reconciled yet).

import { Node, mergeAttributes } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import Suggestion, { exitSuggestion } from "@tiptap/suggestion";
import type { ContainerID } from "loro-crdt";
import type { LoroDocType } from "loro-prosemirror";
import { createStableIdPlugin } from "./stableId";
import { enclosingHeadingId, rankHeadingsByDistance } from "./linkTypeahead";
import { mountEmbeddedEditor } from "./embeddedEditor";
import { LinkTypeahead, type LinkTypeaheadHandle, type LinkTypeaheadProps } from "../LinkTypeahead";
import { subtreeRows, type HeadingDto } from "../../../lib/crdt/outline";

export interface LinkRefOptions {
  /** Live heading outline, read fresh whenever it's needed (typeahead
   * ranking, chip/preview title lookups) — Workspace already recomputes
   * this on every doc update, so this extension just asks for the latest
   * one rather than tracking its own copy. */
  getOutline: () => HeadingDto[];
  /** Levels of descendant headings an expanded link's *fallback* preview
   * shows (see this file's header comment) — mirrors
   * `AppSettings.descendantDepth`, the same knob `HeadingFold` uses for
   * `initialExpandedDepth` (including the live preview's own folding,
   * once mounted). */
  previewDepth: number;
  /** Jumps the real editor to `id` — used for a click on a chip, a click
   * on a row inside the read-only fallback preview, and a click on a row
   * inside the live preview's own nested `LinkRef` instance. */
  onNavigate: (id: string) => void;
  /** Mirrors the expanded-link-id set out to the tree view, the same way
   * `HeadingFold`'s `onChange` mirrors fold state — see `Editor.tsx`. */
  onExpandChange?: (expanded: ReadonlySet<string>) => void;
  /** Whether this editor instance's links can expand into a live nested
   * embedded editor at all. `false` inside an embedded editor itself
   * (`embeddedEditor.ts` sets this) — without it, an `@`-link cycle (A
   * embeds B, B embeds A) would recursively mount live editors forever.
   * A link inside an embedded section still shows its chip and still
   * jumps on click; it just can't expand a level deeper. Defaults to
   * `true`. */
  allowExpand?: boolean;
  /** The live Loro doc a live preview binds its nested sync to — omitted
   * (matching `getContainerId` resolving to `undefined`) falls back to
   * the read-only preview. */
  doc?: LoroDocType;
  /** Resolves a heading id to its own section's Loro container id (see
   * `DendroidDocument.getSectionContainerId`). */
  getContainerId?: (id: string) => ContainerID | undefined;
}

interface ExpandState {
  expanded: Set<string>;
}

type ExpandMeta = { type: "toggle"; id: string } | { type: "set"; ids: Set<string> };

const linkExpandPluginKey = new PluginKey<ExpandState>("linkExpand");
export const linkSuggestionPluginKey = new PluginKey("linkSuggestion");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    linkRef: {
      /** Flips one link between expanded and collapsed. */
      toggleLinkExpand: (id: string) => ReturnType;
      /** Replaces the whole expanded-id set — mirrors `HeadingFold`'s
       * `setHeadingFold`, kept symmetric for external bulk writes (the
       * tree view mirroring a change back in). */
      setLinkExpand: (ids: Iterable<string>) => ReturnType;
    };
  }
}

export const LinkRef = Node.create<LinkRefOptions>({
  name: "linkRef",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return {
      getOutline: () => [],
      previewDepth: 3,
      onNavigate: () => {},
      onExpandChange: undefined,
      allowExpand: true,
      doc: undefined,
      getContainerId: undefined,
    };
  },

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-link-id"),
        renderHTML: (attributes: { id?: string | null }) => (attributes.id ? { "data-link-id": attributes.id } : {}),
      },
      targetId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-target-id"),
        renderHTML: (attributes: { targetId?: string | null }) =>
          attributes.targetId ? { "data-target-id": attributes.targetId } : {},
      },
      // Stamped by backlink reconciliation (dendroid_core::links) only
      // once a link has fully orphaned — every ancestor of its old target
      // was deleted in the same change, so there's nothing left to
      // reparent onto. Kept so the chip can still show something
      // ("~~Deleted heading~~") instead of nothing.
      staleTitle: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-stale-title"),
        renderHTML: (attributes: { staleTitle?: string | null }) =>
          attributes.staleTitle ? { "data-stale-title": attributes.staleTitle } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-link-ref]" }];
  },

  renderHTML({ HTMLAttributes }) {
    // Empty shell — the companion plugin below renders everything visible
    // as a widget decoration, exactly like headingFold's chevrons.
    return ["span", mergeAttributes(HTMLAttributes, { "data-link-ref": "" })];
  },

  addCommands() {
    return {
      toggleLinkExpand:
        (id: string) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(linkExpandPluginKey, { type: "toggle", id } satisfies ExpandMeta));
          return true;
        },
      setLinkExpand:
        (ids: Iterable<string>) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(linkExpandPluginKey, { type: "set", ids: new Set(ids) } satisfies ExpandMeta));
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const { getOutline, previewDepth, onNavigate, onExpandChange, allowExpand, doc, getContainerId } = this.options;

    return [
      createStableIdPlugin("linkRefId", ["linkRef"]),
      expandDecorationPlugin({ getOutline, previewDepth, onNavigate, onExpandChange, allowExpand, doc, getContainerId }),
      Suggestion<HeadingDto, HeadingDto>({
        editor: this.editor,
        char: "@",
        allowSpaces: true,
        pluginKey: linkSuggestionPluginKey,
        items: ({ query, editor }) => {
          const outline = getOutline();
          const currentId = enclosingHeadingId(editor.state.doc, editor.state.selection.from);
          return rankHeadingsByDistance(outline, currentId, query);
        },
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              { type: "linkRef", attrs: { id: crypto.randomUUID(), targetId: props.id } },
              { type: "text", text: " " },
            ])
            .run();
        },
        render: () => {
          let component: ReactRenderer<LinkTypeaheadHandle, LinkTypeaheadProps> | null = null;
          let unmount: (() => void) | null = null;

          return {
            onStart: (props) => {
              component = new ReactRenderer(LinkTypeahead, {
                props: { items: props.items, command: (item: HeadingDto) => props.command(item) },
                editor: props.editor,
              });
              unmount = props.mount(component.element);
            },
            onUpdate: (props) => {
              component?.updateProps({ items: props.items, command: (item: HeadingDto) => props.command(item) });
            },
            onKeyDown: (props) => {
              if (props.event.key === "Escape") {
                exitSuggestion(props.view, linkSuggestionPluginKey);
                return true;
              }
              return component?.ref?.onKeyDown(props.event) ?? false;
            },
            onExit: () => {
              unmount?.();
              component?.destroy();
              component = null;
              unmount = null;
            },
          };
        },
      }),
    ];
  },
});

export interface DecorationOpts {
  getOutline: () => HeadingDto[];
  previewDepth: number;
  onNavigate: (id: string) => void;
  onExpandChange?: (expanded: ReadonlySet<string>) => void;
  allowExpand?: boolean;
  doc?: LoroDocType;
  getContainerId?: (id: string) => ContainerID | undefined;
}

function expandDecorationPlugin(opts: DecorationOpts): Plugin<ExpandState> {
  return new Plugin<ExpandState>({
    key: linkExpandPluginKey,
    state: {
      init: () => ({ expanded: new Set<string>() }),
      apply(tr, value): ExpandState {
        const meta = tr.getMeta(linkExpandPluginKey) as ExpandMeta | undefined;
        if (meta?.type === "toggle") {
          const expanded = new Set(value.expanded);
          if (expanded.has(meta.id)) expanded.delete(meta.id);
          else expanded.add(meta.id);
          return { expanded };
        }
        if (meta?.type === "set") return { expanded: new Set(meta.ids) };
        return value;
      },
    },
    props: {
      decorations(state) {
        const expanded = linkExpandPluginKey.getState(state)?.expanded ?? new Set<string>();
        return buildDecorations(state.doc, expanded, opts);
      },
    },
    view() {
      let last: Set<string> | undefined;
      return {
        update(view) {
          const expanded = linkExpandPluginKey.getState(view.state)?.expanded;
          if (expanded && expanded !== last) {
            last = expanded;
            opts.onExpandChange?.(expanded);
          }
        },
      };
    },
  });
}

/** Exported for `linkRef.test.ts` to exercise directly — specifically the
 * `allowExpand` gate below, which is the one thing standing between an
 * `@`-link cycle (A embeds B, B embeds A) and recursively mounting live
 * editors forever (see this file's own header comment, and
 * `embeddedEditor.ts`'s). Building a `DecorationSet` needs no live
 * `EditorView` — `Decoration.widget`'s callback is stored, not invoked,
 * until something actually renders into a view — so this is testable
 * headlessly against a plain `prosemirror-model` doc. */
export function buildDecorations(doc: ProseMirrorNode, expanded: ReadonlySet<string>, opts: DecorationOpts): DecorationSet {
  const decorations: Decoration[] = [];
  const outline = opts.getOutline();
  const allowExpand = opts.allowExpand !== false;

  doc.descendants((node, pos) => {
    if (node.type.name !== "linkRef") return;
    const id = node.attrs.id as string | null;
    const targetId = node.attrs.targetId as string | null;
    const staleTitle = node.attrs.staleTitle as string | null;
    const isExpanded = allowExpand && !!id && expanded.has(id);
    const heading = targetId ? outline.find((h) => h.id === targetId) : undefined;
    const title = heading?.title || staleTitle || (targetId ? "Untitled" : "Deleted heading");

    decorations.push(
      Decoration.widget(
        pos,
        (view) => buildChip(node, { targetId, staleTitle, isExpanded, outline, allowExpand }, opts, view),
        // The key has to change whenever anything the chip renders does —
        // not just id/targetId/isExpanded — or ProseMirror's widget
        // diffing (`WidgetType.eq`, keyed decorations reuse the old DOM
        // node without ever calling `toDOM` again) treats the section's
        // live rename as a no-op and leaves the stale title on screen.
        { side: 0, key: `${id}:${targetId}:${isExpanded}:${title}` },
      ),
    );

    if (isExpanded && targetId) {
      const containerId = opts.doc && opts.getContainerId ? opts.getContainerId(targetId) : undefined;
      decorations.push(
        Decoration.widget(
          pos + node.nodeSize,
          () => buildPreview(targetId, containerId, outline, opts),
          {
            side: 1,
            // Unlike the chip above, this key deliberately does *not*
            // track the target's content once it resolves to a live
            // container — a mounted embedded editor (`embeddedEditor.ts`)
            // stays in sync with the section on its own, so rebuilding
            // this widget on every content change would just tear down
            // and remount a perfectly-synced nested editor (stealing its
            // focus/cursor) for nothing. It still needs to change when
            // the link's own target changes, or when a container id
            // newly becomes resolvable (e.g. the doc was still
            // reconciling) — the fallback (`static`) preview still needs
            // the content fingerprint, since that one *is* a rebuilt,
            // non-live snapshot.
            key: containerId
              ? `${id}:preview:${targetId}:live`
              : `${id}:preview:${targetId}:static:${previewSignature(subtreeRows(outline, targetId, opts.previewDepth).slice(1))}`,
            destroy: (domNode) => {
              const editor = embeddedEditors.get(domNode as HTMLElement);
              if (editor) {
                editor.destroy();
                embeddedEditors.delete(domNode as HTMLElement);
              }
            },
          },
        ),
      );
    }
  });

  return DecorationSet.create(doc, decorations);
}

/** Tracks which DOM node hosts which live embedded editor, so the
 * decoration's own `destroy` hook (given only the DOM node ProseMirror is
 * tearing down) knows what to clean up — see `buildPreview`. */
const embeddedEditors = new WeakMap<HTMLElement, import("@tiptap/core").Editor>();

/** Content fingerprint for an expanded link's preview rows — folded into
 * the widget decoration's key so a title rename, reorder, or added/removed
 * descendant (anything that changes what the preview should show) forces
 * ProseMirror to redraw it instead of reusing the DOM from the last time
 * this target was expanded. */
function previewSignature(rows: HeadingDto[]): string {
  return rows.map((r) => `${r.id}:${r.depth}:${r.title}`).join("|");
}

function buildChip(
  node: ProseMirrorNode,
  info: { targetId: string | null; staleTitle: string | null; isExpanded: boolean; outline: HeadingDto[]; allowExpand: boolean },
  opts: DecorationOpts,
  view: EditorView,
): HTMLElement {
  const { targetId, staleTitle, isExpanded, outline, allowExpand } = info;
  const heading = targetId ? outline.find((h) => h.id === targetId) : undefined;
  const title = heading?.title || staleTitle || (targetId ? "Untitled" : "Deleted heading");
  const foldable = !!heading && allowExpand;

  const wrapper = document.createElement("span");
  wrapper.className = "link-ref-chip" + (targetId ? "" : " link-ref-chip--orphaned");
  wrapper.contentEditable = "false";

  const toggle = document.createElement("span");
  toggle.className = "link-ref-toggle" + (foldable ? "" : " link-ref-toggle--empty") + (isExpanded ? " is-expanded" : "");
  if (foldable) {
    toggle.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch(view.state.tr.setMeta(linkExpandPluginKey, { type: "toggle", id: node.attrs.id } satisfies ExpandMeta));
    });
  }
  wrapper.appendChild(toggle);

  const label = document.createElement("span");
  label.className = "link-ref-label";
  label.textContent = `@${title}`;
  if (targetId) {
    label.addEventListener("mousedown", (event) => {
      event.preventDefault();
      opts.onNavigate(targetId);
    });
  }
  wrapper.appendChild(label);

  return wrapper;
}

/** The expanded preview widget's DOM — a live nested editor when
 * `containerId` resolves (the common case), the old read-only rebuilt-DOM
 * snapshot otherwise (see this file's header comment). */
function buildPreview(
  targetId: string,
  containerId: ContainerID | undefined,
  outline: HeadingDto[],
  opts: DecorationOpts,
): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "link-ref-preview";
  wrapper.contentEditable = "false";

  if (containerId && opts.doc) {
    const mount = document.createElement("div");
    mount.className = "link-ref-preview__embed";
    wrapper.appendChild(mount);
    const editor = mountEmbeddedEditor({
      element: mount,
      doc: opts.doc,
      containerId,
      getOutline: opts.getOutline,
      previewDepth: opts.previewDepth,
      onNavigate: opts.onNavigate,
    });
    embeddedEditors.set(wrapper, editor);
    return wrapper;
  }

  buildStaticPreview(wrapper, subtreeRows(outline, targetId, opts.previewDepth).slice(1), opts.onNavigate);
  return wrapper;
}

/** The old rebuilt-DOM, read-only, click-to-jump preview — a fallback for
 * when `buildPreview` has no resolvable container id to bind a live
 * editor to. `rows` is the target's subtree, already sliced to drop the
 * target's own row (its title is already what the chip's own label
 * shows). */
function buildStaticPreview(container: HTMLElement, rows: HeadingDto[], onNavigate: (id: string) => void): void {
  const baseDepth = rows[0]?.depth ?? 0;
  for (const row of rows) {
    const rowEl = document.createElement("div");
    rowEl.className = "link-ref-preview__row";
    rowEl.style.paddingLeft = `${(row.depth - baseDepth) * 14}px`;
    rowEl.textContent = row.title || "Untitled";
    rowEl.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onNavigate(row.id);
    });
    container.appendChild(rowEl);
  }
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "link-ref-preview__row link-ref-preview__row--empty";
    empty.textContent = "No content";
    container.appendChild(empty);
  }
}
