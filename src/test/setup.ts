// Runs before every test file (see vitest.config.ts's `setupFiles`).
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// `@testing-library/react`'s own auto-cleanup only self-registers when it
// finds a *global* `afterEach` (Jest-style) — this project's vitest config
// deliberately runs with `globals: false` (explicit imports everywhere
// else), so that auto-detection never fires and, without this, every
// render across a whole test file would pile up in the same jsdom
// `document` instead of unmounting between tests.
afterEach(cleanup);

// jsdom implements neither of these (real layout is out of scope for a DOM
// emulator) — ProseMirror's `EditorView` calls them during selection/coords
// bookkeeping regardless, so a bare jsdom environment throws
// "not implemented" partway through mounting any real `EditorView`. Stubbing
// them out (zero-size rects, same as every other headless-ProseMirror setup
// does) is enough for tests that never assert on actual pixel layout.
if (typeof document !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (document as any).createRange ??= () => ({
    setStart: () => {},
    setEnd: () => {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    getClientRects: () => [],
    commonAncestorContainer: document,
  });
  // `EditorView`'s own mousedown handler calls this (`posAtCoords`) on
  // every click inside the editor, real coordinates or not (jsdom does no
  // layout at all, so there's nothing meaningful to hit-test anyway) —
  // without a stub it throws "not a function" instead of just returning
  // null the way a real click outside any node's rect would.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (document as any).elementFromPoint ??= () => null;
}
