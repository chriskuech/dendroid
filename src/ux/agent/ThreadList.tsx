// The chat drawer's landing screen — every saved thread (lib/types.ts's
// `ChatThread`), one row per kind icon + title, mirroring DatabaseListView's
// "header + new-item control + scrollable rows" shape (see
// ux/database/DatabaseListView.tsx) so the drawer reads as the same
// kind of list dendroid already uses elsewhere. Selecting a row opens it in
// AgentPanel.tsx; the "+" opens NewThreadForm instead of creating inline,
// since even a "human" thread's title is worth a moment's thought and
// cron/trigger threads need real config before they're worth saving.

import type { ChatThread } from "../../lib/types";
import { AgentIcon, IncrementIcon, TrashIcon } from "../../ui/icons";
import { THREAD_KIND_LABEL, ThreadKindIcon } from "./ThreadKindIcon";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { useState } from "react";

interface ThreadListProps {
  threads: ChatThread[];
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

export function ThreadList({ threads, onSelect, onNew, onDelete }: ThreadListProps) {
  const [pendingDelete, setPendingDelete] = useState<ChatThread | null>(null);

  return (
    <div className="thread-list">
      <div className="thread-list__rows">
        {threads.length === 0 ? (
          <div className="agent-panel__empty">
            No chat threads yet.
            <br />
            Start one with the <AgentIcon size={11} style={{ verticalAlign: "-1px" }} /> button below.
          </div>
        ) : (
          threads.map((thread) => (
            <div key={thread.id} className="thread-row" onClick={() => onSelect(thread.id)}>
              <ThreadKindIcon kind={thread.kind} size={13} />
              <div className="thread-row__body">
                <span className="thread-row__title">{thread.title}</span>
                <span className="thread-row__sub">{threadSubtitle(thread)}</span>
              </div>
              <span
                className="thread-row__delete"
                title="Delete thread"
                onClick={(event) => {
                  event.stopPropagation();
                  setPendingDelete(thread);
                }}
              >
                <TrashIcon size={12} />
              </span>
            </div>
          ))
        )}
      </div>
      <div className="thread-list__new">
        <button type="button" className="btn btn--primary thread-list__new-btn" onClick={onNew}>
          <IncrementIcon size={12} />
          New thread
        </button>
      </div>
      <ConfirmDialog
        open={pendingDelete !== null}
        icon={TrashIcon}
        title="Delete thread"
        body={pendingDelete ? `Permanently delete "${pendingDelete.title}"? Its conversation isn't saved anywhere else.` : ""}
        confirmLabel="Delete"
        onConfirm={() => {
          if (pendingDelete) onDelete(pendingDelete.id);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

function threadSubtitle(thread: ChatThread): string {
  if (thread.kind === "cron") return thread.cron ? `${THREAD_KIND_LABEL.cron} · ${thread.cron.schedule}` : THREAD_KIND_LABEL.cron;
  if (thread.kind === "trigger") {
    return thread.trigger ? `${THREAD_KIND_LABEL.trigger} · ${thread.trigger.table}` : THREAD_KIND_LABEL.trigger;
  }
  return THREAD_KIND_LABEL.human;
}
