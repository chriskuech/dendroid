// The fixed-position, edge-anchored sliding drawer — the shared shell
// behind the right AgentPanel (always an overlay). Border, background,
// backdrop, and motion are all defined once, in `.overlay-panel*` (ui.css),
// rather than each caller hand-rolling its own. `side` still supports
// either edge — AgentPanel is the only current caller (`side="right"`), but
// nothing here is specific to it.
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

interface OverlayPanelProps {
  side: "left" | "right";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Screen-reader-only dialog title (Radix requires one). */
  title: string;
  /** Clamped to the viewport; omit to size the drawer from its own content
   * instead of a fixed width. */
  widthPx?: number;
  onBackdropClick?: () => void;
  onEscapeKeyDown?: React.ComponentProps<typeof DialogContent>["onEscapeKeyDown"];
  children: ReactNode;
}

export function OverlayPanel({ side, open, onOpenChange, title, widthPx, onBackdropClick, onEscapeKeyDown, children }: OverlayPanelProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogPortal>
        <DialogOverlay forceMount className="overlay-panel__backdrop" onClick={onBackdropClick} />
        <DialogContent
          forceMount
          className={`overlay-panel overlay-panel--${side}`}
          style={widthPx ? { width: `min(${widthPx}px, 100vw)` } : undefined}
          aria-describedby={undefined}
          onEscapeKeyDown={onEscapeKeyDown}
        >
          <DialogTitle className="sr-only">{title}</DialogTitle>
          {children}
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
