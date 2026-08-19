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
// `modal={false}` + `forceMount` on Content: this drawer needs to animate
// all the way out on close rather than vanishing the instant `open` flips,
// and a force-mounted *modal* Content would hide the rest of the page from
// assistive tech via a mount-only effect that would fire once and never
// revert.
//
// The backdrop is a plain `<div>` rather than Radix's own `DialogOverlay`:
// that component is gated on `context.modal` internally and renders nothing
// at all once the Dialog above is non-modal, silently dropping both the
// dimming and the outside-click-to-close it's meant to provide. Hand-rolling
// it (still `data-state`-driven, so `.overlay-panel__backdrop`'s CSS
// transition keeps working unchanged) is what actually gives outside clicks
// (`onBackdropClick`) somewhere to land while staying non-modal.
//
// That backdrop is opt-out, via `dim` — see its own doc comment below. Only
// the right AgentPanel currently opts out, and only at >=900px, so it can
// stay open alongside the persistent left Sidebar without dimming it or
// eating its clicks.

import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogPortal, DialogTitle } from "./Dialog";
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
  /** Clamped to the viewport; omit to size the drawer from its own content
   * instead of a fixed width. Ignored when `resize` is given — that drives
   * the width instead. */
  widthPx?: number;
  /** Opts this drawer into a drag-to-resize handle on its inner edge (the
   * edge facing the rest of the page — left edge for a `side="right"`
   * drawer, right edge for `side="left"`). Only the agent drawer passes
   * this currently. */
  resize?: OverlayPanelResize;
  /** Whether this drawer dims and blocks the rest of the page while open
   * (the `.overlay-panel__backdrop` layer, and `onBackdropClick`).
   * Defaults to `true` — a drawer with nowhere else for the viewport to put
   * its content really is modal. Pass `false` where another drawer or the
   * persistent Sidebar needs to stay open and interactive alongside this
   * one (the right AgentPanel does, at >=900px — see its own `dim` prop) so
   * the two don't compete for being the one thing on screen. */
  dim?: boolean;
  onBackdropClick?: () => void;
  onEscapeKeyDown?: React.ComponentProps<typeof DialogContent>["onEscapeKeyDown"];
  children: ReactNode;
}

export function OverlayPanel({ side, open, onOpenChange, title, widthPx, resize, dim = true, onBackdropClick, onEscapeKeyDown, children }: OverlayPanelProps) {
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
        {dim && <div className="overlay-panel__backdrop" data-state={open ? "open" : "closed"} onClick={onBackdropClick} />}
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
