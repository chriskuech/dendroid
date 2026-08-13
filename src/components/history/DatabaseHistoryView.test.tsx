// Mirrors HistoryView.test.tsx closely — same list/restore behavior,
// against a mocked `lib/db.ts` instead of a `DendroidDocument` instance
// (see DatabaseListView.test.tsx for why that needs `vi.mock` rather than
// `vi.spyOn`).

import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DatabaseHistoryView } from "./DatabaseHistoryView";
import * as db from "../../lib/db";
import type { DbHistoryEntryDto } from "../../lib/db";

vi.mock("../../lib/db", async () => {
  const actual = await vi.importActual<typeof import("../../lib/db")>("../../lib/db");
  return {
    ...actual,
    dbHistory: vi.fn(),
    dbRevertTo: vi.fn(),
    onDatabasesChanged: vi.fn(() => () => {}),
  };
});

function entry(token: string, overrides: Partial<DbHistoryEntryDto> = {}): DbHistoryEntryDto {
  return { token, timestamp: 0, message: "CREATE TABLE t (v TEXT)", ...overrides };
}

describe("DatabaseHistoryView", () => {
  it("shows an empty state when there's no history yet", async () => {
    vi.mocked(db.dbHistory).mockResolvedValue([]);
    render(<DatabaseHistoryView databaseId="db-1" />);
    expect(await screen.findByText(/no changes recorded yet/i)).toBeInTheDocument();
  });

  it("lists entries, newest first, with 'Current' instead of Restore on the first one", async () => {
    vi.mocked(db.dbHistory).mockResolvedValue([entry("1", { message: "INSERT INTO t VALUES ('two')" }), entry("0")]);
    render(<DatabaseHistoryView databaseId="db-1" />);

    expect(await screen.findByText("INSERT INTO t VALUES ('two')")).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /restore/i })).toHaveLength(1);
  });

  it("restoring an entry asks for confirmation before calling dbRevertTo", async () => {
    const user = userEvent.setup();
    vi.mocked(db.dbHistory).mockResolvedValue([entry("1"), entry("0")]);
    vi.mocked(db.dbRevertTo).mockResolvedValue(undefined);
    render(<DatabaseHistoryView databaseId="db-1" />);

    await user.click(await screen.findByRole("button", { name: /restore/i }));
    expect(screen.getByRole("button", { name: /^roll back$/i })).toBeInTheDocument();
    expect(db.dbRevertTo).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^roll back$/i }));
    await waitFor(() => expect(db.dbRevertTo).toHaveBeenCalledWith("db-1", "0"));
  });

  it("surfaces a fetch error instead of silently showing an empty list", async () => {
    vi.mocked(db.dbHistory).mockRejectedValue(new Error("database not found"));
    render(<DatabaseHistoryView databaseId="db-1" />);
    expect(await screen.findByText(/database not found/i)).toBeInTheDocument();
  });
});
