// Toggleable expand/collapse for sections, rendered as a chevron beside
// each heading and enforced with decorations (hides a collapsed section's
// own body content — everything nested under its heading — without
// touching the document itself; folding is view state, not content,
// matching the "no separate structural CRDT" model in
// dendroid_core::outline). Since a section's whole subtree now genuinely
// lives inside its own node (see `section.ts`), "collapse" is just "hide
// this node's own children after the first" — no more scanning sibling
// ranges by comparing heading levels the way the pre-nesting version had
// to.
//
// The collapsed-id set lives in this plugin's own state so the editor's
// own chevrons and `toggleHeadingFold`/`setHeadingFold` (driven by the
// tree view) both go through the same code path — see `options.onChange`,
// which TreeView listens to via Workspace so both surfaces always agree
// on what's open.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

export interface HeadingFoldOptions {
  /** Sections whose outline depth is >= this start collapsed the first
   * time the doc has any (stamped) sections in it — mirrors
   * `AppSettings.descendantDepth`, "levels rendered below the root".
   * Depth 0 is a top-level heading, so a value of 3 leaves depths 0-2
   * open and folds depth 3+. */
  initialExpandedDepth: number;
  /** Fired whenever the collapsed-id set changes, whether the change came
   * from a click on one of this extension's own chevrons or from an
   * external `toggleHeadingFold`/`setHeadingFold` command call. */
  onChange?: (collapsed: ReadonlySet<string>) => void;
}

interface FoldState {
  collapsed: Set<string>;
  /** Whether the initial depth-based default has been seeded yet — only
   * happens once, the first time the doc has stamped section ids. */
  seeded: boolean;
}

type FoldMeta = { type: "toggle"; id: string } | { type: "set"; ids: Set<string> };

export const headingFoldPluginKey = new PluginKey<FoldState>("headingFold");

const TOGGLE_CLASS = "heading-fold-toggle";
const HIDDEN_CLASS = "heading-fold-hidden";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    headingFold: {
      /** Flips one heading between expanded and collapsed. */
      toggleHeadingFold: (id: string) => ReturnType;
      /** Replaces the whole collapsed-id set — used by the tree view to
       * mirror a change it made in bulk (currently unused there, but kept
       * symmetric with `toggleHeadingFold` for one-off external writes). */
      setHeadingFold: (ids: Iterable<string>) => ReturnType;
    };
  }
}

export const HeadingFold = Extension.create<HeadingFoldOptions>({
  name: "headingFold",

  addOptions() {
    return { initialExpandedDepth: 3, onChange: undefined };
  },

  addCommands() {
    return {
      toggleHeadingFold:
        (id: string) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(headingFoldPluginKey, { type: "toggle", id } satisfies FoldMeta));
          return true;
        },
      setHeadingFold:
        (ids: Iterable<string>) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(headingFoldPluginKey, { type: "set", ids: new Set(ids) } satisfies FoldMeta));
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const { initialExpandedDepth, onChange } = this.options;

    return [
      new Plugin<FoldState>({
        key: headingFoldPluginKey,

        state: {
          init: () => ({ collapsed: new Set<string>(), seeded: false }),
          apply(tr: Transaction, value: FoldState): FoldState {
            let { collapsed, seeded } = value;
            const meta = tr.getMeta(headingFoldPluginKey) as FoldMeta | undefined;

            if (meta?.type === "toggle") {
              collapsed = new Set(collapsed);
              if (collapsed.has(meta.id)) collapsed.delete(meta.id);
              else collapsed.add(meta.id);
            } else if (meta?.type === "set") {
              collapsed = new Set(meta.ids);
            }

            if (!seeded) {
              const sections = collectSections(tr.doc);
              if (sections.length > 0) {
                collapsed = new Set(collapsed);
                for (const s of sections) if (s.depth >= initialExpandedDepth) collapsed.add(s.id);
                seeded = true;
              }
            }

            return { collapsed, seeded };
          },
        },

        props: {
          decorations(state) {
            const fold = headingFoldPluginKey.getState(state);
            return buildDecorations(state.doc, fold?.collapsed ?? new Set());
          },
          handleClickOn(view, _pos, node, _nodePos, event) {
            if (node.type.name !== "section" || !node.attrs.id) return false;
            const target = event.target as HTMLElement | null;
            if (!target?.closest(`.${TOGGLE_CLASS}`)) return false;
            view.dispatch(
              view.state.tr.setMeta(headingFoldPluginKey, { type: "toggle", id: node.attrs.id } satisfies FoldMeta),
            );
            return true;
          },
        },

        view() {
          let last: Set<string> | undefined;
          return {
            update(view) {
              const collapsed = headingFoldPluginKey.getState(view.state)?.collapsed;
              if (collapsed && collapsed !== last) {
                last = collapsed;
                onChange?.(collapsed);
              }
            },
          };
        },
      }),
    ];
  },
});

interface SectionInfo {
  id: string;
  depth: number;
}

/** Every stamped section in the document, depth-first — same shape
 * `dendroid_core::outline::outline`'s recursive walk produces, just over
 * the live PM doc instead of the raw Loro containers. */
function collectSections(doc: ProseMirrorNode): SectionInfo[] {
  const out: SectionInfo[] = [];
  function walk(node: ProseMirrorNode, depth: number) {
    node.forEach((child) => {
      if (child.type.name === "section" && child.attrs.id) {
        out.push({ id: child.attrs.id as string, depth });
        walk(child, depth + 1);
      }
    });
  }
  walk(doc, 0);
  return out;
}

/** Builds both the fold chevrons (one per section, positioned at the
 * start of its heading's own content) and the hidden-node decorations for
 * whatever's currently collapsed — each of a collapsed section's own
 * children *after* its leading heading. */
function buildDecorations(doc: ProseMirrorNode, collapsed: ReadonlySet<string>): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (node.type.name !== "section" || !node.attrs.id) return true;
    const id = node.attrs.id as string;
    const heading = node.firstChild;
    const foldable = node.childCount > 1;
    const isCollapsed = collapsed.has(id);

    if (heading) {
      decorations.push(
        Decoration.widget(
          pos + 2, // pos = section's own position; +1 = the heading's position; +1 = start of its own content
          () => {
            const toggle = document.createElement("span");
            toggle.className = TOGGLE_CLASS + (foldable ? "" : ` ${TOGGLE_CLASS}--empty`) + (isCollapsed ? " is-collapsed" : "");
            toggle.contentEditable = "false";
            return toggle;
          },
          { side: -1, key: `${id}:${isCollapsed}:${foldable}` },
        ),
      );
    }

    if (isCollapsed && foldable) {
      node.forEach((child, offset, index) => {
        if (index === 0) return; // the heading itself always stays visible
        const from = pos + 1 + offset;
        decorations.push(Decoration.node(from, from + child.nodeSize, { class: HIDDEN_CLASS }));
      });
    }

    return true; // keep walking into nested sections regardless of this one's own fold state — a deeply-nested chevron still needs its own decoration even while hidden under a collapsed ancestor (CSS hides the whole subtree either way)
  });

  return DecorationSet.create(doc, decorations);
}
