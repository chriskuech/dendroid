// CRUD for the persisted chat-thread list (lib/types.ts's `ChatThread`),
// backed by the same Tauri store settingsStore.ts already uses for
// `AppSettings`/`Workspace`. Live connection state — the ACP session, its
// streamed timeline — is deliberately not part of this module; that's
// owned by components/agent/AgentPanel.tsx, the only thing that ever needs
// it, the same way this app never centralizes UI-only state that has
// exactly one consumer.

import { loadThreads, saveThreads } from "./settingsStore";
import type { ChatThread, CronThreadConfig, ThreadKind, TriggerEvent, TriggerThreadConfig } from "./types";

function newId(): string {
  return crypto.randomUUID();
}

function defaultTitle(kind: ThreadKind): string {
  return kind === "human" ? "New thread" : kind === "cron" ? "New scheduled thread" : "New trigger thread";
}

export async function listThreads(): Promise<ChatThread[]> {
  return loadThreads();
}

async function mutate(fn: (threads: ChatThread[]) => ChatThread[]): Promise<ChatThread[]> {
  const next = fn(await loadThreads());
  await saveThreads(next);
  return next;
}

export interface NewThreadInput {
  kind: ThreadKind;
  title: string;
  cron?: CronThreadConfig;
  trigger?: TriggerThreadConfig;
}

export async function createThread(input: NewThreadInput): Promise<ChatThread> {
  const thread: ChatThread = {
    id: newId(),
    kind: input.kind,
    title: input.title.trim() || defaultTitle(input.kind),
    createdAt: new Date().toISOString(),
    cron: input.cron,
    trigger: input.trigger,
  };
  await mutate((threads) => [...threads, thread]);
  return thread;
}

export async function renameThread(id: string, title: string): Promise<void> {
  await mutate((threads) => threads.map((t) => (t.id === id ? { ...t, title: title.trim() || t.title } : t)));
}

/** Replaces a "cron"/"trigger" thread's own config in place — used by the
 * chat view's inline config editor. Leaves `kind` alone; a thread's kind is
 * fixed at creation (see `AgentPanel.tsx`'s new-thread flow), since
 * changing it out from under an existing conversation would leave stale
 * config of the wrong shape (`trigger` set on a "cron" thread, or vice
 * versa) with nothing to reconcile it. */
export async function updateThreadConfig(id: string, patch: Pick<ChatThread, "cron" | "trigger">): Promise<void> {
  await mutate((threads) => threads.map((t) => (t.id === id ? { ...t, ...patch } : t)));
}

export async function deleteThread(id: string): Promise<void> {
  await mutate((threads) => threads.filter((t) => t.id !== id));
}

/** Builds the event JSON a live SQLite row-level trigger would eventually
 * hand a "trigger" thread's `skill` as its parameter — `{database, table,
 * event, row, firedAt}`. Used by `AgentPanel.tsx`'s "Run now" (see
 * `ChatThread`'s doc comment for why that's a manual stand-in rather than
 * dendroid actually watching the table yet) to compose a realistic prompt
 * out of whatever event kind and row the user picks to simulate. */
export function buildTriggerEventJson(trigger: TriggerThreadConfig, event: TriggerEvent, row: Record<string, unknown> = {}): string {
  return JSON.stringify({ database: trigger.databaseId, table: trigger.table, event, row, firedAt: new Date().toISOString() }, null, 2);
}
