// Covers the history list (fetch/render/most-recent-first labeling) and
// the restore flow (confirm dialog gate, `crdt.revertTo` call, refresh
// after) — against a real `DendroidDocument` with `history`/`revertTo`
// stubbed, since it's a class with private fields (a plain duck-typed
// mock wouldn't structurally satisfy its type).

import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HistoryView } from "./HistoryView";
import { DendroidDocument } from "../../lib/crdt/document";
import type { HistoryEntryDto } from "../../lib/crdt/history";

function entry(token: string, overrides: Partial<HistoryEntryDto> = {}): HistoryEntryDto {
  return { token, timestamp: 0, message: "", len: 1, ...overrides };
}

function makeCrdt(entries: HistoryEntryDto[]) {
  const crdt = new DendroidDocument();
  vi.spyOn(crdt, "history").mockResolvedValue(entries);
  vi.spyOn(crdt, "revertTo").mockResolvedValue(undefined);
  return crdt;
}

describe("HistoryView", () => {
  it("shows an empty state when there's no history yet", async () => {
    const crdt = makeCrdt([]);
    render(<HistoryView crdt={crdt} />);
    expect(await screen.findByText(/no changes recorded yet/i)).toBeInTheDocument();
  });

  it("lists entries, newest first, with 'Current' instead of Restore on the first one", async () => {
    const crdt = makeCrdt([entry("t2", { message: "Rollback" }), entry("t1", { len: 3 })]);
    render(<HistoryView crdt={crdt} />);

    expect(await screen.findByText("Rollback")).toBeInTheDocument();
    expect(screen.getByText("3 changes")).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
    // Only the older entry gets a Restore button — the newest one is
    // already the current state.
    expect(screen.getAllByRole("button", { name: /restore/i })).toHaveLength(1);
  });

  it("prints 'Unknown time' for a zero timestamp instead of an epoch date", async () => {
    const crdt = makeCrdt([entry("t1", { timestamp: 0 })]);
    render(<HistoryView crdt={crdt} />);
    expect(await screen.findByText("Unknown time")).toBeInTheDocument();
  });

  it("restoring an entry asks for confirmation before calling revertTo", async () => {
    const user = userEvent.setup();
    const crdt = makeCrdt([entry("current"), entry("older")]);
    render(<HistoryView crdt={crdt} />);

    await user.click(await screen.findByRole("button", { name: /restore/i }));
    expect(screen.getByRole("button", { name: /^roll back$/i })).toBeInTheDocument();
    expect(crdt.revertTo).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^roll back$/i }));
    await waitFor(() => expect(crdt.revertTo).toHaveBeenCalledWith("older"));
  });

  it("cancelling the confirmation never calls revertTo", async () => {
    const user = userEvent.setup();
    const crdt = makeCrdt([entry("current"), entry("older")]);
    render(<HistoryView crdt={crdt} />);

    await user.click(await screen.findByRole("button", { name: /restore/i }));
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(crdt.revertTo).not.toHaveBeenCalled();
  });

  it("surfaces a fetch error instead of silently showing an empty list", async () => {
    const crdt = new DendroidDocument();
    vi.spyOn(crdt, "history").mockRejectedValue(new Error("ledger unreadable"));
    render(<HistoryView crdt={crdt} />);
    expect(await screen.findByText(/ledger unreadable/i)).toBeInTheDocument();
  });
});
