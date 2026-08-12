import { useEffect, useRef, useState } from "react";

// Zen mode's chrome-fade behavior — see whitepaper.md's Editor > Mode
// section ("when cursor moves to the Editor, other UI elements outside the
// editor fade out, then fade in upon movement") and
// comp/Dendroid Design System.dc.html's Motion section for the exact
// timings. Opacity only, never layout, so nothing reflows while writing.
// Exported so `useZenCursor` shares the same idle countdown — the pointer
// and the chrome should feel like one unified recede, even though they
// wake on different conditions (see that hook's comment).
export const IDLE_MS = 1200;
const FADE_OUT_MS = 600;
const FADE_IN_MS = 120;

export interface ZenChrome {
  /** Whether the chrome should currently render faded. */
  faded: boolean;
  /** CSS transition-duration to pair with `faded` — longer going out (an
   * idle recede) than coming back (an immediate response to input). */
  transitionMs: number;
}

/**
 * `active` gates the whole thing to zen mode — pass
 * `settings.editorMode === "zen"`. Overlay mode never fades: this returns
 * `faded: false` throughout, same as before this feature existed.
 *
 * `editorFocused` is whether the cursor is currently in the editor (see
 * Editor.tsx's `onFocusChange`) — the idle countdown only runs while it is,
 * and losing focus restores the chrome immediately rather than leaving it
 * faded behind an unrelated UI.
 */
export function useZenChrome(active: boolean, editorFocused: boolean): ZenChrome {
  const [faded, setFaded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!active || !editorFocused) {
      setFaded(false);
      if (timerRef.current) clearTimeout(timerRef.current);
      return;
    }

    function scheduleFade() {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setFaded(true), IDLE_MS);
    }

    function wake(event: PointerEvent | KeyboardEvent) {
      // Ordinary keystrokes (typing) shouldn't keep waking the chrome —
      // that would defeat the point of zen mode. Only a Cmd/Ctrl chord
      // (reaching for a shortcut that likely involves the chrome) counts.
      if (event.type === "keydown" && !(event as KeyboardEvent).metaKey && !(event as KeyboardEvent).ctrlKey) return;
      // Same reasoning for pointer movement: moving the cursor around
      // within the editor (selecting text, writing) shouldn't wake the
      // chrome either. Only once the pointer leaves the editor area —
      // heading toward the now-faded chrome — does it count as intent to
      // bring it back.
      if (event.type === "pointermove") {
        const pointerEvent = event as PointerEvent;
        // WebKit (Tauri's WKWebView on macOS) synthesizes a `pointermove`
        // with the cursor's *last* coordinates whenever content shifts
        // underneath a perfectly still pointer — e.g. the tree sidebar
        // re-laying out on every keystroke while the mouse happens to
        // rest over it. `movementX/Y` is 0 for that phantom event (the
        // cursor itself never moved), unlike a real move, so this is the
        // one case genuine motion can't produce — filtering it out is
        // what stops idle typing from being mistaken for "reaching
        // toward the chrome" and permanently keeping it awake.
        if (pointerEvent.movementX === 0 && pointerEvent.movementY === 0) return;
        const target = pointerEvent.target;
        if (target instanceof Element && target.closest(".doc-editor")) return;
      }
      setFaded(false);
      scheduleFade();
    }

    scheduleFade();
    window.addEventListener("pointermove", wake);
    window.addEventListener("keydown", wake as EventListener);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("keydown", wake as EventListener);
    };
  }, [active, editorFocused]);

  return { faded, transitionMs: faded ? FADE_OUT_MS : FADE_IN_MS };
}
