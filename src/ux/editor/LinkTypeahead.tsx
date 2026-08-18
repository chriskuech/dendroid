// The floating `@`-link candidate list — mounted by `linkRef.ts`'s
// `Suggestion` wiring via `@tiptap/suggestion`'s managed `props.mount()`
// positioning (no separate positioning library needed). Items already
// arrive ranked (see `ux/editor/tiptap/linkTypeahead.ts`'s `rankHeadingsByDistance`)
// and filtered by the in-progress query; this component only owns which
// row is currently highlighted and forwards keyboard navigation.

import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import type { HeadingDto } from "../../lib/crdt/outline";
import "./linkTypeahead.css";

export interface LinkTypeaheadHandle {
  /** Forwarded from `Suggestion`'s `render().onKeyDown` — returns whether
   * this component handled the key (and so the editor shouldn't). */
  onKeyDown: (event: KeyboardEvent) => boolean;
}

export interface LinkTypeaheadProps {
  items: HeadingDto[];
  command: (item: HeadingDto) => void;
}

export const LinkTypeahead = forwardRef<LinkTypeaheadHandle, LinkTypeaheadProps>(function LinkTypeahead(
  { items, command },
  ref,
) {
  const [selected, setSelected] = useState(0);

  // A fresh query result should always start highlighting the top (most
  // relevant) match rather than whatever index happened to be selected
  // before.
  useEffect(() => setSelected(0), [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown(event) {
      if (items.length === 0) return false;
      if (event.key === "ArrowDown") {
        setSelected((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        setSelected((i) => (i - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        command(items[selected]);
        return true;
      }
      return false;
    },
  }));

  return (
    <div className="link-typeahead">
      {items.length === 0 ? (
        <div className="link-typeahead__empty">No matching headings</div>
      ) : (
        items.map((item, i) => (
          <div
            key={item.id}
            className={`link-typeahead__row${i === selected ? " is-selected" : ""}`}
            onMouseDown={(event) => {
              // Keep the editor's own selection/focus intact — a plain
              // click would otherwise blur the editor before `command`
              // gets a chance to replace the trigger range.
              event.preventDefault();
              command(item);
            }}
            onMouseEnter={() => setSelected(i)}
          >
            <span className="link-typeahead__level">{"#".repeat(Math.max(item.level, 1))}</span>
            <span className="link-typeahead__title">{item.title || "Untitled"}</span>
          </div>
        ))
      )}
    </div>
  );
});
