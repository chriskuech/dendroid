// Thin re-export of Radix's Dialog primitive under `ui/` — the shared
// entry point for every overlay that isn't a destructive confirmation (see
// `ConfirmDialog.tsx`, built on `@radix-ui/react-alert-dialog` instead: an
// alertdialog role and no light-dismiss is the correct a11y contract there,
// but wrong for an ordinary modal or drawer).
//
// Deliberately not a single opinionated `<Dialog>` component: this app's
// overlays range from a mount/unmount-on-demand centered modal
// (EncryptionModal) to persistent slide-in drawers with their own
// asymmetric open/close motion and multi-step Escape handling (AgentPanel,
// Workspace's narrow-viewport tree drawer). Re-exporting the primitive
// parts lets each call site compose exactly the structure and transition
// it needs — same pattern ConfirmDialog already uses with AlertDialog —
// while still getting Radix's focus trap, focus return, and Escape/outside
// handling for free instead of hand-rolled listeners.
//
// Always render Content (and Overlay, if used) inside `DialogPortal` — it
// moves them to `document.body`, so a `position: fixed` overlay never ends
// up clipped or re-anchored by an ancestor that happens to set `filter`/
// `transform` (both create a new containing block for `fixed` children).

import * as DialogPrimitive from "@radix-ui/react-dialog";

export const Dialog = DialogPrimitive.Root;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogOverlay = DialogPrimitive.Overlay;
export const DialogContent = DialogPrimitive.Content;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
export const DialogClose = DialogPrimitive.Close;
