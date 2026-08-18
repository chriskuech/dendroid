// The header row shared by every side-panel screen — see `.side-panel__*`
// in ui.css for the CSS half of this pair. One `icon` slot up front (a
// static icon, or a back button — ThreadChat and AutomationsView's
// drill-down screens swap one in for the other), a label that always
// truncates and eats remaining space, an optional trailing status, and an
// optional close button. Replaces eight near-identical hand-rolled copies
// of this same row (TreeView, MindMapView, HistoryView, DatabaseListView,
// AutomationsView, AgentPanel's thread list, ThreadChat, NewThreadForm).

import type { ReactNode } from "react";
import { CloseIcon } from "./icons";

interface SidePanelHeaderProps {
  /** A static icon, or a back button (ThreadChat, AutomationsView's
   * drill-down screens) — omitted entirely by NewThreadForm, which has
   * nothing to show before the label. */
  icon?: ReactNode;
  label: ReactNode;
  /** Trailing status text before the close button — only ThreadChat uses
   * this, for its connection state. */
  status?: ReactNode;
  statusError?: boolean;
  onClose?: () => void;
  closeLabel?: string;
}

export function SidePanelHeader({ icon, label, status, statusError, onClose, closeLabel = "Close" }: SidePanelHeaderProps) {
  return (
    <div className="side-panel__header">
      {icon}
      <span className="side-panel__label">{label}</span>
      {status && <span className={`side-panel__status${statusError ? " side-panel__status--error" : ""}`}>{status}</span>}
      {onClose && (
        <button type="button" className="side-panel__icon-btn" onClick={onClose} aria-label={closeLabel}>
          <CloseIcon size={16} />
        </button>
      )}
    </div>
  );
}
