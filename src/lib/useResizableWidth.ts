// Shared drag-to-resize logic for the two width-adjustable panels — the
// persistent left Sidebar (ux/sidebar/Sidebar.tsx) and the right agent
// chat drawer (ux/agent/AgentPanel.tsx, via ui/OverlayPanel.tsx's `resize`
// prop). Follows the same "onPointerDown sets pointer capture on the
// dragged element itself; onPointerMove/onPointerUp read from it directly"
// convention MindMapView.tsx's node dragging already uses, rather than
// window-level listeners.
//
// Width updates live (local state) on every pointermove for immediate
// visual feedback, but `onResize` only fires once, with the final clamped
// value, on pointerup — callers persist that into AppSettings (see
// AppState's `updateSettings`), and writing to disk on every pixel of a
// drag would be wasteful.

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

interface UseResizableWidthOptions {
  /** The committed width (px) to resize from — typically a persisted
   * setting. Ignored mid-drag (the hook tracks its own live value then). */
  width: number;
  min: number;
  max: number;
  /** Which edge of the panel the returned `handleProps` are attached to:
   * "end" if dragging the pointer right should grow the panel (handle on
   * its trailing/right edge, panel anchored to the left); "start" if
   * dragging left should grow it (handle on its leading/left edge, panel
   * anchored to the right). */
  edge: "start" | "end";
  /** Fires once, with the final clamped width, on pointerup. */
  onResize: (width: number) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function useResizableWidth({ width, min, max, edge, onResize }: UseResizableWidthOptions) {
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<Element>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      // Optional-chained: real browsers always have this, but jsdom
      // (tests) doesn't implement pointer capture at all — same guard
      // MindMapView.tsx's node dragging uses.
      event.currentTarget.setPointerCapture?.(event.pointerId);
      dragRef.current = { startX: event.clientX, startWidth: width };
      setLiveWidth(width);
    },
    [width],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<Element>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = event.clientX - drag.startX;
      const delta = edge === "end" ? dx : -dx;
      setLiveWidth(clamp(drag.startWidth + delta, min, max));
    },
    [edge, min, max],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<Element>) => {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag) return;
      setLiveWidth((current) => {
        if (current !== null) onResize(current);
        return null;
      });
    },
    [onResize],
  );

  return {
    /** Live width while dragging, otherwise the committed `width` prop. */
    width: liveWidth ?? width,
    isDragging: liveWidth !== null,
    handleProps: { onPointerDown, onPointerMove, onPointerUp },
  };
}
