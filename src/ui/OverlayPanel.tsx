// The fixed-position, edge-anchored sliding drawer — the actual shared
// shell behind both the right AgentPanel (always an overlay) and the left
// Sidebar's <900px drawer (Workspace.tsx). These used to each hand-roll
// their own Dialog/backdrop/positioning/motion — a translateX slide with a
// flat rgba backdrop on the agent side, a blur/opacity "deblur" with a
// blur-only backdrop on the tree side — and kept drifting apart (most
// recently: only the agent side had a box-shadow). Routing both through one
// component makes that class of drift structurally impossible instead of
// just currently-fixed: border, background, backdrop, and motion are all
// defined once, in `.overlay-panel*` (ui.css), not per caller.
//
// `modal={false}` + `forceMount` on both Overlay and Content: this drawer
// needs to animate all the way out on close rather than vanishing the
// instant `open` flips, and a force-mounted *modal* Content would hide the
// rest of the page from assistive tech via a mount-only effect that would
// fire once and never revert. The Overlay still blocks clicks to the page
// behind it while open (via `pointer-events` in the CSS's `data-state`
// rule), so outside-click protection isn't lost by going non-modal.

import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogOverlay, DialogPortal, DialogTitle } from "./Dialog";
import { useResizableWidth } from "../lib/useResizableWidth";

interface OverlayPanelResize {
  /** Current committed width (px) — typically a persisted setting. */
  width: number;
  min: number;
  max: number;
  /** Fires once, with the final width, on pointerup — see
   * `lib/useResizableWidth.ts`. */
  onResize: (width: number) => void;
}

interface OverlayPanelProps {
  side: "left" | "right";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Screen-reader-only dialog title (Radix requires one). */
  title: string;
  /** Only the agent drawer sets this (clamped to the viewport); the tree
   * drawer sizes itself from its rail + content children instead. Ignored
   * when `resize` is given — that drives the width instead. */
  widthPx?: number;
  /** Opts this drawer into a drag-to-resize handle on its inner edge (the
   * edge facing the rest of the page — left edge for a `side="right"`
   * drawer, right edge for `side="left"`). Only the agent drawer passes
   * this currently; the tree drawer stays fixed-to-content. */
  resize?: OverlayPanelResize;
  onBackdropClick?: () => void;
  onEscapeKeyDown?: React.ComponentProps<typeof DialogContent>["onEscapeKeyDown"];
  children: ReactNode;
}

export function OverlayPanel({ side, open, onOpenChange, title, widthPx, resize, onBackdropClick, onEscapeKeyDown, children }: OverlayPanelProps) {
  // Hook called unconditionally (Rules of Hooks) — its return is only used
  // below when `resize` is actually given, via `effectiveWidthPx`/the
  // handle's render guard.
  const { width: liveWidth, handleProps } = useResizableWidth({
    width: resize?.width ?? 0,
    min: resize?.min ?? 0,
    max: resize?.max ?? 0,
    edge: side === "right" ? "start" : "end",
    onResize: resize?.onResize ?? (() => {}),
  });
  const effectiveWidthPx = resize ? liveWidth : widthPx;

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogPortal>
        <DialogOverlay forceMount className="overlay-panel__backdrop" onClick={onBackdropClick} />
        <DialogContent
          forceMount
          className={`overlay-panel overlay-panel--${side}`}
          style={effectiveWidthPx ? { width: `min(${effectiveWidthPx}px, 100vw)` } : undefined}
          aria-describedby={undefined}
          onEscapeKeyDown={onEscapeKeyDown}
        >
          <DialogTitle className="sr-only">{title}</DialogTitle>
          {children}
          {resize && (
            <div
              className={`overlay-panel__resize-handle overlay-panel__resize-handle--${side}`}
              role="separator"
              aria-orientation="vertical"
              aria-label={`Resize ${title.toLowerCase()}`}
              {...handleProps}
            />
          )}
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
