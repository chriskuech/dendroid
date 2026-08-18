// Covers list/create/delete against a mocked `adapters/db` adapter — a
// plain object of functions (unlike `DendroidDocument`), so `vi.mock`
// stands in for the Tauri IPC boundary rather than spying on a class
// instance the way `HistoryView.test.tsx` does for `crdt`.

import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DatabaseListView } from "./DatabaseListView";
import * as db from "../../adapters/db";

vi.mock("../../adapters/db", async () => {
  const actual = await vi.importActual<typeof import("../../adapters/db")>("../../adapters/db");
  return {
    ...actual,
    adapter: {
      ...actual.adapter,
      listDatabases: vi.fn(),
      createDatabase: vi.fn(),
      deleteDatabase: vi.fn(),
      onDatabasesChanged: vi.fn(() => () => {}),
    },
  };
});

describe("DatabaseListView", () => {
  it("shows an empty state when there are no databases yet", async () => {
    vi.mocked(db.adapter.listDatabases).mockResolvedValue([]);
    render(<DatabaseListView selectedId={null} onSelect={vi.fn()} />);
    expect(await screen.findByText(/no databases yet/i)).toBeInTheDocument();
  });

  it("lists databases and highlights the selected one", async () => {
    vi.mocked(db.adapter.listDatabases).mockResolvedValue([
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
    ]);
    render(<DatabaseListView selectedId="b" onSelect={vi.fn()} />);

    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("Beta").closest(".database-row")).toHaveClass("is-active");
    expect(screen.getByText("Alpha").closest(".database-row")).not.toHaveClass("is-active");
  });

  it("clicking a row selects it", async () => {
    const user = userEvent.setup();
    vi.mocked(db.adapter.listDatabases).mockResolvedValue([{ id: "a", name: "Alpha" }]);
    const onSelect = vi.fn();
    render(<DatabaseListView selectedId={null} onSelect={onSelect} />);

    await user.click(await screen.findByText("Alpha"));
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("creating a database calls createDatabase and selects the new id", async () => {
    const user = userEvent.setup();
    vi.mocked(db.adapter.listDatabases).mockResolvedValue([]);
    vi.mocked(db.adapter.createDatabase).mockResolvedValue("new-id");
    const onSelect = vi.fn();
    render(<DatabaseListView selectedId={null} onSelect={onSelect} />);

    await screen.findByText(/no databases yet/i);
    await user.type(screen.getByPlaceholderText(/new database name/i), "Tasks");
    await user.click(screen.getByRole("button", { name: /create database/i }));

    await waitFor(() => expect(db.adapter.createDatabase).toHaveBeenCalledWith("Tasks"));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("new-id"));
  });

  it("deleting a database asks for confirmation before calling deleteDatabase", async () => {
    const user = userEvent.setup();
    vi.mocked(db.adapter.listDatabases).mockResolvedValue([{ id: "a", name: "Alpha" }]);
    vi.mocked(db.adapter.deleteDatabase).mockResolvedValue(undefined);
    render(<DatabaseListView selectedId={null} onSelect={vi.fn()} />);

    await screen.findByText("Alpha");
    await user.click(screen.getByTitle(/delete database/i));
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeInTheDocument();
    expect(db.adapter.deleteDatabase).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(db.adapter.deleteDatabase).toHaveBeenCalledWith("a"));
  });

  it("surfaces a fetch error instead of silently showing an empty list", async () => {
    vi.mocked(db.adapter.listDatabases).mockRejectedValue(new Error("workspace unreadable"));
    render(<DatabaseListView selectedId={null} onSelect={vi.fn()} />);
    expect(await screen.findByText(/workspace unreadable/i)).toBeInTheDocument();
  });
});
