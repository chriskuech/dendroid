// The destructive-confirmation pattern from comp/Dendroid Screens.dc.html
// section "05 Confirmation" — same deblur motion as the settings/search
// overlays, a danger hairline instead of the neutral one, the destructive
// verb kept on the destructive button, and Cancel (never the destructive
// action) getting the initial focus so a stray Enter can't confirm it.
//
// Originally built with no call site (Settings' "Remove key" is disabled
// until encryption itself exists — see whitepaper.md) as ready
// infrastructure for when that lands, same as the rest of ui/'s primitives
// mirror comp/Dendroid Design System.dc.html section 06 independent of how
// many call sites they have on a given day. Its first real call site is
// History's "Roll back" prompt (components/history/HistoryView.tsx) —
// `icon` was pulled out to a prop then, so each caller reads as itself
// instead of every confirmation looking like a key removal.

import { useEffect, useRef, type ComponentType } from "react";
import type { IconProps } from "../icons";
import { Button } from "./Button";
import "../../styles/ui.css";

export interface ConfirmDialogDetail {
  label: string;
  value: string;
}

export interface ConfirmDialogProps {
  open: boolean;
  icon: ComponentType<IconProps>;
  title: string;
  body: string;
  /** Optional key/value table — e.g. what "Remove key" would list: the key
   * fingerprint, how many events it encrypted, which trees. */
  details?: ConfirmDialogDetail[];
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ open, icon: Icon, title, body, details, confirmLabel, onConfirm, onCancel }: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onCancel();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        onConfirm();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onCancel, onConfirm]);

  return (
    <div
      className="confirm-dialog__backdrop"
      onClick={onCancel}
      style={{
        opacity: open ? 1 : 0,
        pointerEvents: open ? "auto" : "none",
        backdropFilter: `blur(${open ? 14 : 0}px)`,
        WebkitBackdropFilter: `blur(${open ? 14 : 0}px)`,
        // Entrance and exit both animate opacity + blur, but exit is
        // uniformly faster with no stagger — "exits are always faster than
        // entrances" (comp/Dendroid Design System.dc.html's Motion section).
        transition: open
          ? "opacity 200ms cubic-bezier(0.2, 0, 0, 1), backdrop-filter 200ms cubic-bezier(0.2, 0, 0, 1)"
          : "opacity 130ms cubic-bezier(0.2, 0, 0, 1), backdrop-filter 130ms cubic-bezier(0.2, 0, 0, 1)",
      }}
    >
      <div
        className="confirm-dialog"
        // Stops a click inside the panel from bubbling to the backdrop's
        // own onClick and dismissing the dialog it was meant to interact
        // with — same result as the comp's flat backdrop/panel siblings,
        // just via event handling instead of DOM structure.
        onClick={(e) => e.stopPropagation()}
        style={{
          opacity: open ? 1 : 0,
          filter: `blur(${open ? 0 : 10}px)`,
          transition: open
            ? "opacity 240ms cubic-bezier(0.2, 0, 0, 1) 40ms, filter 240ms cubic-bezier(0.2, 0, 0, 1) 40ms"
            : "opacity 130ms cubic-bezier(0.2, 0, 0, 1), filter 130ms cubic-bezier(0.2, 0, 0, 1)",
        }}
      >
        <div className="confirm-dialog__header">
          <Icon size={16} style={{ color: "var(--danger)" }} />
          <span className="confirm-dialog__title">{title}</span>
          <span className="confirm-dialog__esc">esc</span>
        </div>
        <p className="confirm-dialog__body">{body}</p>
        {details && details.length > 0 && (
          <div className="confirm-dialog__details">
            {details.map((d) => (
              <div className="confirm-dialog__detail" key={d.label}>
                <span className="confirm-dialog__detail-label">{d.label}</span>
                <span className="confirm-dialog__detail-value">{d.value}</span>
              </div>
            ))}
          </div>
        )}
        <div className="confirm-dialog__footer">
          <Button ref={cancelRef} variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {confirmLabel}
          </Button>
          <span className="confirm-dialog__cmd-enter">⌘↵</span>
        </div>
      </div>
    </div>
  );
}
