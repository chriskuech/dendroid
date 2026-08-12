import { useEffect, useRef, useState } from "react";
import { IDLE_MS } from "./useZenChrome";

/**
 * Zen mode's cursor-hide behavior. Sibling to `useZenChrome`, sharing its
 * idle countdown (`IDLE_MS`) and its `active`/`editorFocused` gating, but
 * deliberately *not* sharing its `faded` value: `useZenChrome`'s wake
 * listener ignores pointer movement that stays inside `.doc-editor` (so
 * writing doesn't keep flickering the sidebar back in) — reusing that for
 * the cursor itself meant the OS pointer stayed invisible even once you
 * genuinely moved the mouse, as long as it hadn't left the editor. The
 * cursor has no such exception: it's the thing your hand is moving, so any
 * real motion — anywhere — brings it back immediately.
 *
 * No fade here despite the name; `cursor` isn't an animatable CSS
 * property, so this is a hard toggle rather than an opacity transition —
 * see AppState.tsx's `document.body.style.cursor` effect.
 */
export function useZenCursor(active: boolean, editorFocused: boolean): boolean {
  const [hidden, setHidden] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!active || !editorFocused) {
      setHidden(false);
      if (timerRef.current) clearTimeout(timerRef.current);
      return;
    }

    function scheduleHide() {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setHidden(true), IDLE_MS);
    }

    function wake(event: PointerEvent) {
      // Same phantom-event filter as useZenChrome: WebKit (Tauri's
      // WKWebView on macOS) synthesizes a `pointermove` with the cursor's
      // *last* coordinates whenever content shifts underneath a
      // perfectly still pointer — e.g. the tree sidebar re-laying out on
      // every keystroke. `movementX/Y` is 0 for that phantom event, never
      // for a real move, so this is the one case genuine motion can't
      // produce.
      if (event.movementX === 0 && event.movementY === 0) return;
      setHidden(false);
      scheduleHide();
    }

    scheduleHide();
    window.addEventListener("pointermove", wake);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      window.removeEventListener("pointermove", wake);
    };
  }, [active, editorFocused]);

  return hidden;
}
