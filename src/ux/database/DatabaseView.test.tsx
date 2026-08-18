// Smoke coverage for the table UI: loading a table's rows, editing a cell,
// adding/deleting a row, and creating a new table — each just checking the
// right `adapters/db` call goes out, since the actual persistence/replay
// logic is covered on the Rust side (`src-core/tests/sqldb.rs`).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DatabaseView } from "./DatabaseView";
import * as db from "../../adapters/db";
import type { TableRowsDto } from "../../adapters/db";

vi.mock("../../adapters/db", async () => {
  const actual = await vi.importActual<typeof import("../../adapters/db")>("../../adapters/db");
  return {
    ...actual,
    adapter: {
      ...actual.adapter,
      listTables: vi.fn(),
      tableRows: vi.fn(),
      execSql: vi.fn(),
      queryDb: vi.fn(),
      onDatabasesChanged: vi.fn(() => () => {}),
    },
  };
});

const database = { id: "db-1", name: "Tasks" };

function rowsFixture(): TableRowsDto {
  return {
    columns: [
      { name: "title", sqlType: "TEXT", notNull: false, primaryKey: false },
      { name: "done", sqlType: "INTEGER", notNull: false, primaryKey: false },
    ],
    rows: [
      { rowid: 1, values: ["Write tests", 0] },
      { rowid: 2, values: [null, 1] },
    ],
    totalRows: 2,
  };
}

describe("DatabaseView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows an empty state when there are no tables yet", async () => {
    vi.mocked(db.adapter.listTables).mockResolvedValue([]);
    render(<DatabaseView database={database} onClose={vi.fn()} />);
    expect(await screen.findByText(/no tables yet/i)).toBeInTheDocument();
  });

  it("renders the first table's rows, showing NULL distinctly from an empty string", async () => {
    vi.mocked(db.adapter.listTables).mockResolvedValue([{ name: "todos", columns: rowsFixture().columns }]);
    vi.mocked(db.adapter.tableRows).mockResolvedValue(rowsFixture());
    render(<DatabaseView database={database} onClose={vi.fn()} />);

    expect(await screen.findByText("Write tests")).toBeInTheDocument();
    expect(screen.getByText("NULL")).toBeInTheDocument();
    expect(screen.getByText("1–2 of 2")).toBeInTheDocument();
  });

  it("editing a cell commits an UPDATE addressed by rowid", async () => {
    const user = userEvent.setup();
    vi.mocked(db.adapter.listTables).mockResolvedValue([{ name: "todos", columns: rowsFixture().columns }]);
    vi.mocked(db.adapter.tableRows).mockResolvedValue(rowsFixture());
    vi.mocked(db.adapter.execSql).mockResolvedValue(undefined);
    render(<DatabaseView database={database} onClose={vi.fn()} />);

    const cell = await screen.findByText("Write tests");
    await user.click(cell);
    const input = screen.getByDisplayValue("Write tests");
    await user.clear(input);
    await user.type(input, "Ship it");
    await user.tab();

    await waitFor(() =>
      expect(db.adapter.execSql).toHaveBeenCalledWith(
        "db-1",
        'UPDATE "todos" SET "title" = ?1 WHERE rowid = ?2',
        ["Ship it", 1],
        false,
      ),
    );
  });

  it("Add row inserts default values into the selected table", async () => {
    const user = userEvent.setup();
    vi.mocked(db.adapter.listTables).mockResolvedValue([{ name: "todos", columns: rowsFixture().columns }]);
    vi.mocked(db.adapter.tableRows).mockResolvedValue(rowsFixture());
    vi.mocked(db.adapter.execSql).mockResolvedValue(undefined);
    render(<DatabaseView database={database} onClose={vi.fn()} />);

    await screen.findByText("Write tests");
    await user.click(screen.getByRole("button", { name: /add row/i }));

    await waitFor(() => expect(db.adapter.execSql).toHaveBeenCalledWith("db-1", 'INSERT INTO "todos" DEFAULT VALUES', [], false));
  });

  it("deleting a row runs a DELETE addressed by rowid", async () => {
    const user = userEvent.setup();
    vi.mocked(db.adapter.listTables).mockResolvedValue([{ name: "todos", columns: rowsFixture().columns }]);
    vi.mocked(db.adapter.tableRows).mockResolvedValue(rowsFixture());
    vi.mocked(db.adapter.execSql).mockResolvedValue(undefined);
    render(<DatabaseView database={database} onClose={vi.fn()} />);

    await screen.findByText("Write tests");
    await user.click(screen.getAllByTitle(/delete row/i)[0]);

    await waitFor(() => expect(db.adapter.execSql).toHaveBeenCalledWith("db-1", 'DELETE FROM "todos" WHERE rowid = ?1', [1], false));
  });

  it("creating a table runs a quoted CREATE TABLE and selects it", async () => {
    const user = userEvent.setup();
    vi.mocked(db.adapter.listTables).mockResolvedValueOnce([]).mockResolvedValue([{ name: "people", columns: [] }]);
    vi.mocked(db.adapter.tableRows).mockResolvedValue({ columns: [], rows: [], totalRows: 0 });
    vi.mocked(db.adapter.execSql).mockResolvedValue(undefined);
    render(<DatabaseView database={database} onClose={vi.fn()} />);

    await screen.findByText(/no tables yet/i);
    await user.click(screen.getByRole("button", { name: /new table/i }));
    await user.type(screen.getByPlaceholderText(/table name/i), "people");
    await user.type(screen.getByPlaceholderText("column"), "name");
    await user.click(screen.getByRole("button", { name: /^create table$/i }));

    await waitFor(() => expect(db.adapter.execSql).toHaveBeenCalledWith("db-1", 'CREATE TABLE "people" ("name" TEXT)', [], false));
  });

  it("clicking 'Back to notes' calls onClose", async () => {
    const user = userEvent.setup();
    vi.mocked(db.adapter.listTables).mockResolvedValue([]);
    const onClose = vi.fn();
    render(<DatabaseView database={database} onClose={onClose} />);

    await screen.findByText(/no tables yet/i);
    await user.click(screen.getByRole("button", { name: /back to notes/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("clicking a column header cycles ascending → descending → unsorted", async () => {
    const user = userEvent.setup();
    vi.mocked(db.adapter.listTables).mockResolvedValue([{ name: "todos", columns: rowsFixture().columns }]);
    vi.mocked(db.adapter.tableRows).mockResolvedValue(rowsFixture());
    render(<DatabaseView database={database} onClose={vi.fn()} />);

    await screen.findByText("Write tests");
    vi.mocked(db.adapter.tableRows).mockClear();

    const header = screen.getByText("title");
    await user.click(header);
    await waitFor(() => expect(db.adapter.tableRows).toHaveBeenLastCalledWith("db-1", "todos", 50, 0, "title", false));

    await user.click(header);
    await waitFor(() => expect(db.adapter.tableRows).toHaveBeenLastCalledWith("db-1", "todos", 50, 0, "title", true));

    await user.click(header);
    await waitFor(() => expect(db.adapter.tableRows).toHaveBeenLastCalledWith("db-1", "todos", 50, 0, null, false));
  });

  it("running a SELECT in the SQL editor queries instead of executing, and renders a result grid", async () => {
    const user = userEvent.setup();
    vi.mocked(db.adapter.listTables).mockResolvedValue([{ name: "todos", columns: rowsFixture().columns }]);
    vi.mocked(db.adapter.tableRows).mockResolvedValue(rowsFixture());
    vi.mocked(db.adapter.queryDb).mockResolvedValue({ columns: ["title"], rows: [["Write tests"], ["Ship it"]] });
    render(<DatabaseView database={database} onClose={vi.fn()} />);

    await screen.findByText("Write tests");
    await user.click(screen.getByRole("button", { name: /sql editor/i }));
    const textarea = screen.getByPlaceholderText(/select to preview/i);
    await user.type(textarea, "SELECT title FROM todos");
    await user.click(screen.getByRole("button", { name: /^run$/i }));

    await waitFor(() => expect(db.adapter.queryDb).toHaveBeenCalledWith("db-1", "SELECT title FROM todos"));
    expect(db.adapter.execSql).not.toHaveBeenCalled();
    expect(await screen.findByText("Ship it")).toBeInTheDocument();
    expect(screen.getByText("2 rows")).toBeInTheDocument();
  });

  it("running a mutating statement in the SQL editor executes it as a ledgered batch", async () => {
    const user = userEvent.setup();
    vi.mocked(db.adapter.listTables).mockResolvedValue([{ name: "todos", columns: rowsFixture().columns }]);
    vi.mocked(db.adapter.tableRows).mockResolvedValue(rowsFixture());
    vi.mocked(db.adapter.execSql).mockResolvedValue(undefined);
    render(<DatabaseView database={database} onClose={vi.fn()} />);

    await screen.findByText("Write tests");
    await user.click(screen.getByRole("button", { name: /sql editor/i }));
    const textarea = screen.getByPlaceholderText(/select to preview/i);
    await user.type(textarea, "DELETE FROM todos WHERE done = 1");
    await user.click(screen.getByRole("button", { name: /^run$/i }));

    await waitFor(() => expect(db.adapter.execSql).toHaveBeenCalledWith("db-1", "DELETE FROM todos WHERE done = 1", [], true));
    expect(db.adapter.queryDb).not.toHaveBeenCalled();
  });

  it("typing a table-name prefix in the SQL editor offers it as a typeahead suggestion", async () => {
    const user = userEvent.setup();
    vi.mocked(db.adapter.listTables).mockResolvedValue([{ name: "todos", columns: rowsFixture().columns }]);
    vi.mocked(db.adapter.tableRows).mockResolvedValue(rowsFixture());
    render(<DatabaseView database={database} onClose={vi.fn()} />);

    await screen.findByText("Write tests");
    await user.click(screen.getByRole("button", { name: /sql editor/i }));
    const textarea = screen.getByPlaceholderText(/select to preview/i);
    await user.type(textarea, "SELECT * FROM tod");

    // "todos" also names a tab in the table strip, so scope the query to
    // the typeahead dropdown's own list item rather than `getByText`.
    const suggestion = await screen.findByRole("listitem");
    expect(suggestion).toHaveTextContent("todos");
    await user.click(suggestion);

    expect(textarea).toHaveValue("SELECT * FROM todos");
  });
});
