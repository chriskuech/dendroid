// Computes the pixel position of a caret inside a `<textarea>` — what
// `SqlEditor` (`components/database/DatabaseView.tsx`) uses to anchor its
// typeahead dropdown at the word currently being typed rather than
// somewhere generic like "below the whole textarea".
//
// A `<textarea>` has no DOM API for "where is character N on screen" (a
// contenteditable does, via `Range`, but a plain textarea doesn't). The
// standard workaround — used by every "@mention" or "/command" textarea
// autocomplete that isn't built on contenteditable — is this one: build an
// invisible `<div>` that mirrors the textarea's box exactly (same font,
// padding, border, width, white-space wrapping), fill it with the text up
// to the caret, and measure where that text's last character actually
// landed. Since the mirror uses the identical font metrics and wraps
// identically, that measurement matches where the real caret sits in the
// real textarea, modulo the textarea's own scroll offset (subtracted by
// the caller).

const MIRRORED_PROPERTIES = [
  "boxSizing",
  "width",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderStyle",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "lineHeight",
  "fontFamily",
  "textAlign",
  "textTransform",
  "textIndent",
  "textDecoration",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
] as const;

let mirrorDiv: HTMLDivElement | null = null;

function getMirror(): HTMLDivElement {
  if (!mirrorDiv) {
    mirrorDiv = document.createElement("div");
    mirrorDiv.style.position = "absolute";
    mirrorDiv.style.visibility = "hidden";
    mirrorDiv.style.top = "0";
    mirrorDiv.style.left = "-9999px";
    mirrorDiv.style.whiteSpace = "pre-wrap";
    mirrorDiv.style.wordWrap = "break-word";
    document.body.appendChild(mirrorDiv);
  }
  return mirrorDiv;
}

export interface CaretCoords {
  /** Distance from the textarea's own top edge to the caret's line,
   * ignoring scroll — the caller subtracts `textarea.scrollTop`. */
  top: number;
  left: number;
  /** The caret's line height, so the caller can anchor a dropdown just
   * below the line rather than overlapping it. */
  height: number;
}

/** Where character index `position` sits inside `textarea`, relative to
 * the textarea's own top-left corner (before accounting for scroll). */
export function getCaretCoordinates(textarea: HTMLTextAreaElement, position: number): CaretCoords {
  const div = getMirror();
  const computed = window.getComputedStyle(textarea);

  for (const prop of MIRRORED_PROPERTIES) {
    div.style[prop] = computed[prop];
  }

  div.textContent = textarea.value.slice(0, position);
  const span = document.createElement("span");
  // A trailing space collapses to zero width, so a non-empty placeholder
  // ensures the span always has a measurable position even at end-of-text.
  span.textContent = textarea.value.slice(position) || ".";
  div.appendChild(span);

  const coords: CaretCoords = {
    top: span.offsetTop,
    left: span.offsetLeft,
    height: parseInt(computed.lineHeight, 10) || span.offsetHeight,
  };

  div.textContent = "";
  return coords;
}
