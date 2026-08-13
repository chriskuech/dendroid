// The one place `ThreadKind` (lib/types.ts) maps to an icon — shared by
// ThreadList.tsx's rows, NewThreadForm.tsx's kind picker, and AgentPanel.tsx's
// chat header, so the three surfaces can never drift apart on which glyph
// means which kind.

import { AgentIcon, CronIcon, TriggerIcon, type IconProps } from "../icons";
import type { ThreadKind } from "../../lib/types";

export function ThreadKindIcon({ kind, ...props }: { kind: ThreadKind } & IconProps) {
  if (kind === "cron") return <CronIcon {...props} />;
  if (kind === "trigger") return <TriggerIcon {...props} />;
  return <AgentIcon {...props} />;
}

export const THREAD_KIND_LABEL: Record<ThreadKind, string> = {
  human: "Chat",
  cron: "Scheduled",
  trigger: "Trigger",
};
