// A persistent, top-of-view status bar — unlike a toast, this doesn't
// auto-dismiss: it reflects real, ongoing state (e.g. "sync is stopped
// right now"), so it stays up for exactly as long as that state does.
// There's no shared toast/alert primitive elsewhere in the app (every
// other error surface is local, inline status text — see e.g.
// `HistoryView.tsx`'s `history-view__status--error`); this is the first
// thing that needs to interrupt the *whole* workspace view rather than
// just one panel within it, which is why it's a new primitive instead of
// another inline `*__status--error` span.

import type { ComponentType } from "react";
import type { IconProps } from "./icons";
import "./ui.css";

export interface BannerProps {
  icon: ComponentType<IconProps>;
  children: React.ReactNode;
}

export function Banner({ icon: Icon, children }: BannerProps) {
  return (
    <div className="banner" role="alert">
      <Icon size={16} />
      <span className="banner__text">{children}</span>
    </div>
  );
}
