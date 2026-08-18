// Stable node identity, shared by every node type that needs one. Plain
// ProseMirror node attrs aren't durable on their own — nothing assigns them
// by default — but once set here they persist through `loro-prosemirror`
// exactly like any other node attr (they live in that node's own
// `attributes` Loro map).
//
// Used by `section.ts` (a `section` — not the `heading` it wraps — is what
// the outline, `@`-links, and "scroll to heading" navigation address by
// id; see dendroid_core::outline) and by `linkRef` nodes (see `linkRef.ts`,
// which need the same stamping for their own instance id, used to key
// per-link expand/collapse state since the same heading can be linked from
// multiple places) — one generic plugin shared by both rather than
// duplicated.

import { Plugin, PluginKey } from "@tiptap/pm/state";

/** One `appendTransaction` plugin that stamps a fresh id onto every node of
 * any of `nodeTypeNames` that doesn't have one yet, whenever the doc
 * changes. `keyName` namespaces the plugin (ProseMirror plugin keys must be
 * unique per editor). */
export function createStableIdPlugin(keyName: string, nodeTypeNames: readonly string[]): Plugin {
  const names = new Set(nodeTypeNames);
  return new Plugin({
    key: new PluginKey(keyName),
    appendTransaction(transactions, oldState, newState) {
      const docChanged = transactions.some((tr) => tr.docChanged) && !oldState.doc.eq(newState.doc);
      if (!docChanged) return null;

      let tr = newState.tr;
      let modified = false;
      newState.doc.descendants((node, pos) => {
        if (names.has(node.type.name) && !node.attrs.id) {
          tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: crypto.randomUUID() });
          modified = true;
        }
      });
      return modified ? tr : null;
    },
  });
}
