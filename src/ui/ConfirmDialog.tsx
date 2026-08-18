// The destructive-confirmation pattern from comp/Dendroid Screens.dc.html
// section "05 Confirmation" — a blurred-in backdrop and panel, a danger
// hairline instead of the neutral one, the destructive verb kept on the
// destructive button, and Cancel (never the destructive action) getting
// the initial focus so a stray Enter can't confirm it.
//
// Built on Radix's AlertDialog (rather than Dialog) since every call site
// is a destructive-choice confirmation — that gets us the ARIA alertdialog
// role, a focus trap, and native Escape-to-close for free. The entrance
// blur/fade is a plain CSS @keyframes animation keyed off Radix's own
// `data-state="open"` (see ui.css) rather than the old hand-rolled version's
// JS-computed inline transition — AlertDialog is always modal, and a modal
// Content only reverts the "hide the rest of the page from assistive tech"
// effect it applies while open if it's actually allowed to unmount on
// close, which a keyframe-driven exit would need force-mounting to avoid
// (see AgentPanel.tsx's `modal={false}` comment for the bug that causes).
// Closing is instant instead of an exit transition — a smaller trade than
// hiding the whole app from screen readers whenever any confirm dialog
// exists on the page, mounted or not.
//
// Originally built with no call site (Settings' "Remove key" is disabled
// until encryption itself exists — see whitepaper.md) as ready
// infrastructure for when that lands, same as the rest of ui/'s primitives
// mirror comp/Dendroid Design System.dc.html section 06 independent of how
// many call sites they have on a given day. Its first real call site is
// History's "Roll back" prompt (ux/history/HistoryView.tsx) —
// `icon` was pulled out to a prop then, so each caller reads as itself
// instead of every confirmation looking like a key removal.

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useRef, type ComponentType } from "react";
import type { IconProps } from "./icons";
import { Button } from "./Button";
import "./ui.css";

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

  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialog.Overlay className="confirm-dialog__backdrop" onClick={onCancel} />
      <AlertDialog.Content
        className="confirm-dialog"
        // Cancel — never the destructive action — gets the initial focus so
        // a stray Enter can't confirm it; Radix's default (first tabbable
        // element) would already land here, but this makes it explicit.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          cancelRef.current?.focus();
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onConfirm();
        }}
      >
        <div className="confirm-dialog__header">
          <Icon size={16} style={{ color: "var(--danger)" }} />
          <AlertDialog.Title className="confirm-dialog__title">{title}</AlertDialog.Title>
          <span className="confirm-dialog__esc">esc</span>
        </div>
        <AlertDialog.Description className="confirm-dialog__body">{body}</AlertDialog.Description>
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
          <AlertDialog.Cancel ref={cancelRef} asChild>
            <Button variant="secondary">Cancel</Button>
          </AlertDialog.Cancel>
          {/* Deliberately a plain Button, not AlertDialog.Action: Action is
           * DialogPrimitive.Close underneath, which fires Root's
           * onOpenChange(false) as a side effect of any click — that would
           * call onCancel() right after onConfirm() ran. The caller already
           * closes the dialog itself (by flipping `open` to false) once its
           * confirm handler resolves, so Action's auto-close isn't needed
           * here and only Cancel/Escape should route through onCancel. */}
          <Button variant="destructive" onClick={onConfirm}>
            {confirmLabel}
          </Button>
          <span className="confirm-dialog__cmd-enter">⌘↵</span>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
