// Scopes the editor to a single heading's subtree — "any node can become
// the editor root" (comp/Dendroid Design System.dc.html section 03). Same
// hide-by-decoration approach as headingFold: rooting is view state, not
// content, so it never touches the document itself. Unlike headingFold,
// there's only ever one root at a time, and setting it hides everything
// *outside* the rooted section's own subtree rather than inside a
// collapsed one.
//
// A rooted section can now be nested arbitrarily deep (not just a
// top-level sibling — see `section.ts`), so "everything outside the root"
// means every *sibling* of every ancestor on the path down to it. An
// ancestor itself stays visible (its own heading and body content) —
// only the branches that don't lead to the root get hidden — which reads
// as a breadcrumb trail down to the rooted section rather than a full
// "zoom" that also hides each ancestor's own heading/content. Simpler,
// and safer, than surgically hiding an ancestor's own heading token while
// keeping the rest of it live-editable.
//
// The root id lives in this plugin's own state so a click on the toggle
// this extension renders at the end of each heading and a click on the
// tree view's reroot icon (routed back in via `toggleDocumentRoot`, driven
// by Workspace) both go through the same code path — see `options.onChange`,
// which TreeView listens to (via Workspace) so both surfaces always agree
// on which heading, if any, is currently the root.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

export interface DocRootOptions {
  /** Fired whenever the root changes, whether from a click on this
   * extension's own end-of-heading toggle or an external
   * `toggleDocumentRoot`/`setDocumentRoot` command call. */
  onChange?: (rootId: string | null) => void;
}

interface DocRootState {
  rootId: string | null;
}

type DocRootMeta = { type: "set"; id: string | null };

export const docRootPluginKey = new PluginKey<DocRootState>("docRoot");

const TOGGLE_CLASS = "heading-reroot-toggle";
const OUT_OF_ROOT_CLASS = "doc-root-hidden";
const LEVEL_CLASS_PREFIX = "doc-root-level-";
// Same cap as the tag-based h1-h3 sizing in workspace.css (there's no
// custom style past level 3 to begin with) — a heading nested deeper than
// that below the root just keeps the level-3 look rather than shrinking
// further.
const MAX_STYLED_LEVEL = 3;

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    docRoot: {
      /** Scopes the editor to `id`'s subtree, or clears the root if `id`
       * is already the root — what both this extension's own toggle and
       * the tree view's reroot icon call. */
      toggleDocumentRoot: (id: string) => ReturnType;
      /** Sets (or, with `null`, clears) the root directly, without the
       * toggle-off-if-already-root behavior. */
      setDocumentRoot: (id: string | null) => ReturnType;
    };
  }
}

export const DocRoot = Extension.create<DocRootOptions>({
  name: "docRoot",

  addOptions() {
    return { onChange: undefined };
  },

  addCommands() {
    return {
      toggleDocumentRoot:
        (id: string) =>
        ({ state, tr, dispatch }) => {
          const current = docRootPluginKey.getState(state)?.rootId ?? null;
          if (dispatch) {
            dispatch(tr.setMeta(docRootPluginKey, { type: "set", id: current === id ? null : id } satisfies DocRootMeta));
          }
          return true;
        },
      setDocumentRoot:
        (id: string | null) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(docRootPluginKey, { type: "set", id } satisfies DocRootMeta));
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const { onChange } = this.options;

    return [
      new Plugin<DocRootState>({
        key: docRootPluginKey,

        state: {
          init: () => ({ rootId: null }),
          apply(tr: Transaction, value: DocRootState, _oldState, newState): DocRootState {
            let { rootId } = value;
            const meta = tr.getMeta(docRootPluginKey) as DocRootMeta | undefined;

            if (meta?.type === "set") rootId = meta.id;

            // A rooted section that gets deleted (or loses its id) leaves
            // nothing to scope to — fall back to the whole document
            // rather than hiding everything.
            if (rootId && tr.docChanged && !hasSection(newState.doc, rootId)) rootId = null;

            return { rootId };
          },
        },

        props: {
          decorations(state) {
            const root = docRootPluginKey.getState(state);
            return buildDecorations(state.doc, root?.rootId ?? null);
          },
          handleClickOn(view, _pos, node, _nodePos, event) {
            if (node.type.name !== "section" || !node.attrs.id) return false;
            const target = event.target as HTMLElement | null;
            if (!target?.closest(`.${TOGGLE_CLASS}`)) return false;
            const current = docRootPluginKey.getState(view.state)?.rootId ?? null;
            view.dispatch(
              view.state.tr.setMeta(docRootPluginKey, {
                type: "set",
                id: current === node.attrs.id ? null : node.attrs.id,
              } satisfies DocRootMeta),
            );
            return true;
          },
        },

        view() {
          let last: string | null | undefined;
          return {
            update(view) {
              const rootId = docRootPluginKey.getState(view.state)?.rootId ?? null;
              if (rootId !== last) {
                last = rootId;
                onChange?.(rootId);
              }
            },
          };
        },
      }),
    ];
  },
});

/** True if some `section` anywhere in `doc` still carries `id`. */
function hasSection(doc: ProseMirrorNode, id: string): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.type.name === "section" && node.attrs.id === id) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

/** The path of sections from the document's own top level down to (and
 * including) `id`, shallowest first — `null` if `id` isn't found. */
function findSectionPath(doc: ProseMirrorNode, id: string): ProseMirrorNode[] | null {
  const path: ProseMirrorNode[] = [];

  function walk(node: ProseMirrorNode): boolean {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type.name !== "section") continue;
      path.push(child);
      if (child.attrs.id === id) return true;
      if (walk(child)) return true;
      path.pop();
    }
    return false;
  }

  return walk(doc) ? path : null;
}

/** Builds the end-of-heading reroot toggles (one per section), the
 * hidden-node decorations for whatever's currently rooted (every sibling
 * of every ancestor on the path to it, per this file's header comment),
 * and — for the rooted section's own subtree — a class that resolves each
 * heading's level *relative to the root* rather than its literal one, so
 * the root always reads as a level-1 heading ("#") and its descendants
 * shift up to match, however deep they actually sit in the document. */
function buildDecorations(doc: ProseMirrorNode, rootId: string | null): DecorationSet {
  const decorations: Decoration[] = [];
  const path = rootId ? findSectionPath(doc, rootId) : null;
  const pathNodes = path ? new Set(path) : null;
  const rootLevel = path && path.length > 0 ? headingLevel(path[path.length - 1]) : undefined;
  const rootNode = path && path.length > 0 ? path[path.length - 1] : null;

  function headingLevel(section: ProseMirrorNode): number {
    return (section.firstChild?.attrs.level as number | undefined) ?? 1;
  }

  /** Once we've descended into the rooted section itself, every heading
   * below it gets relabeled relative to the root. */
  function walk(node: ProseMirrorNode, pos: number, insideRoot: boolean) {
    node.forEach((child, offset) => {
      if (child.type.name !== "section" || !child.attrs.id) return;
      const childPos = pos + 1 + offset;

      if (pathNodes && !pathNodes.has(child) && !insideRoot) {
        decorations.push(Decoration.node(childPos, childPos + child.nodeSize, { class: OUT_OF_ROOT_CLASS }));
        return; // hidden entirely — nothing inside it needs decorating
      }

      const nowInsideRoot = insideRoot || child === rootNode;
      if (nowInsideRoot && rootLevel !== undefined) {
        const heading = child.firstChild;
        if (heading) {
          const level = headingLevel(child);
          const effectiveLevel = Math.min(Math.max(level - rootLevel + 1, 1), MAX_STYLED_LEVEL);
          decorations.push(
            Decoration.node(childPos + 1, childPos + 1 + heading.nodeSize, { class: `${LEVEL_CLASS_PREFIX}${effectiveLevel}` }),
          );
        }
      }

      addRerootToggle(child, childPos);
      walk(child, childPos, nowInsideRoot);
    });
  }

  function addRerootToggle(section: ProseMirrorNode, pos: number) {
    const heading = section.firstChild;
    if (!heading) return;
    const isRoot = section.attrs.id === rootId;

    // A brand-new, still-untitled heading has `nodeSize` 2 — no content
    // token between its open/close, so "end of content" (this widget's
    // position) and "start of content" (headingFold's own fold-toggle
    // widget) are the exact same position. Two `contenteditable="false"`
    // widgets landing back to back there sandwich the browser's only
    // caret position for that heading between them, with no editable
    // content in between. Chromium tolerates typing there; WebKit
    // doesn't — it silently drops every keystroke, so the heading you
    // just typed "## " for never gets a title. Skipping the reroot toggle
    // until there's a title sidesteps the collision (still shown once
    // already rooted, so un-rooting stays reachable even mid-retitle).
    if (heading.content.size === 0 && !isRoot) return;

    const headingPos = pos + 1;
    decorations.push(
      Decoration.widget(
        headingPos + heading.nodeSize - 1,
        () => {
          const toggle = document.createElement("span");
          toggle.className = TOGGLE_CLASS + (isRoot ? " is-root" : "");
          toggle.contentEditable = "false";
          toggle.title = isRoot ? "Reset root" : "Set as root";
          return toggle;
        },
        { side: 1, key: `${section.attrs.id}:${isRoot}` },
      ),
    );
  }

  walk(doc, 0, rootId === null);

  return DecorationSet.create(doc, decorations);
}
