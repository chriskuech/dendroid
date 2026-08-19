// CRUD for the persisted chat-thread list (lib/types.ts's `ChatThread`),
// backed by the same Tauri store settingsStore.ts already uses for
// `AppSettings`/`Workspace`. Live connection state — the ACP session, its
// streamed timeline — is deliberately not part of this module; that's
// owned by ux/agent/AgentPanel.tsx, the only thing that ever needs
// it, the same way this app never centralizes UI-only state that has
// exactly one consumer.

import { adapter as settingsStore } from "../../adapters/settingsStore";
import type { ChatThread } from "../../lib/types";

function newId(): string {
  return crypto.randomUUID();
}

export async function listThreads(): Promise<ChatThread[]> {
  return settingsStore.loadThreads();
}

async function mutate(fn: (threads: ChatThread[]) => ChatThread[]): Promise<ChatThread[]> {
  const next = fn(await settingsStore.loadThreads());
  await settingsStore.saveThreads(next);
  return next;
}

/** Creates a new chat thread — "New thread" unless a non-blank title is
 * given (renameThread handles retitling afterward). No other input: a
 * thread is always just a conversation with the agent, see `ChatThread`'s
 * doc comment. */
export async function createThread(title = ""): Promise<ChatThread> {
  const thread: ChatThread = {
    id: newId(),
    title: title.trim() || "New thread",
    createdAt: new Date().toISOString(),
  };
  await mutate((threads) => [...threads, thread]);
  return thread;
}

export async function renameThread(id: string, title: string): Promise<void> {
  await mutate((threads) => threads.map((t) => (t.id === id ? { ...t, title: title.trim() || t.title } : t)));
}

export async function deleteThread(id: string): Promise<void> {
  await mutate((threads) => threads.filter((t) => t.id !== id));
}
