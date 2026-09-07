/**
 * The Kanban pipeline — component coverage (docs/BMS_EXTENSION.md §2.3).
 *
 * The two properties that matter are accessibility and honesty: a card must be
 * movable without a pointer, and a card must never sit somewhere the server
 * refused to put it.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OrderBoard, type BoardOrder } from "./order-board";

const order = (over: Partial<BoardOrder> = {}): BoardOrder => ({
  id: "order-1",
  status: "draft",
  currency: "EUR",
  totalMinor: 60_000,
  balanceMinor: 60_000,
  customerLabel: "Jane Doe",
  lineSummary: "24ft Pontoon Boat — 4 hours",
  createdAt: "2026-06-15T09:00:00.000Z",
  ...over,
});

const column = (name: RegExp) => screen.getByRole("region", { name });

describe("OrderBoard", () => {
  it("renders a column per status, with counts", () => {
    render(<OrderBoard orders={[order()]} onMove={vi.fn()} />);

    expect(column(/^Draft, 1 orders$/)).toBeInTheDocument();
    expect(column(/^Awaiting payment, 0 orders$/)).toBeInTheDocument();
    expect(column(/^Completed, 0 orders$/)).toBeInTheDocument();
  });

  it("offers only the transitions the state machine allows", async () => {
    render(<OrderBoard orders={[order({ status: "draft" })]} onMove={vi.fn()} />);

    const select = screen.getByRole("combobox");
    const options = within(select)
      .getAllByRole("option")
      .map((option) => option.textContent);

    // draft -> pending_payment | confirmed | cancelled, and nothing else.
    expect(options).toEqual(["Choose…", "Awaiting payment", "Confirmed", "Cancelled"]);
    expect(options).not.toContain("In progress");
    expect(options).not.toContain("Completed");
  });

  it("gives a terminal card no way to move at all", () => {
    render(<OrderBoard orders={[order({ status: "completed" })]} onMove={vi.fn()} />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("moves a card with the keyboard, not only by dragging", async () => {
    const user = userEvent.setup();
    const onMove = vi.fn(async () => true);
    render(<OrderBoard orders={[order({ status: "draft" })]} onMove={onMove} />);

    await user.selectOptions(screen.getByRole("combobox"), "confirmed");

    expect(onMove).toHaveBeenCalledWith("order-1", "confirmed");
    await waitFor(() => {
      expect(column(/^Confirmed, 1 orders$/)).toBeInTheDocument();
    });
  });

  it("moves the card immediately, before the server has answered", async () => {
    const user = userEvent.setup();
    let resolve!: (value: boolean) => void;
    const onMove = vi.fn(() => new Promise<boolean>((r) => (resolve = r)));
    render(<OrderBoard orders={[order({ status: "draft" })]} onMove={onMove} />);

    await user.selectOptions(screen.getByRole("combobox"), "confirmed");

    // Still in flight — the card has already landed.
    await waitFor(() => expect(column(/^Confirmed, 1 orders$/)).toBeInTheDocument());
    resolve(true);
  });

  it("puts the card back and says why when the server refuses", async () => {
    const user = userEvent.setup();
    const onMove = vi.fn(async () => false);
    render(<OrderBoard orders={[order({ status: "draft" })]} onMove={onMove} />);

    await user.selectOptions(screen.getByRole("combobox"), "confirmed");

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Draft → Confirmed was refused.");
    });
    expect(column(/^Draft, 1 orders$/)).toBeInTheDocument();
    expect(column(/^Confirmed, 0 orders$/)).toBeInTheDocument();
  });

  it("shows the outstanding balance, and says Paid when there is none", () => {
    render(
      <OrderBoard
        orders={[
          order({ id: "a", balanceMinor: 42_000 }),
          order({ id: "b", status: "confirmed", balanceMinor: 0 }),
        ]}
        onMove={vi.fn()}
      />,
    );

    expect(screen.getByText(/420\.00 due/)).toBeInTheDocument();
    expect(screen.getByText("Paid")).toBeInTheDocument();
  });

  it("says so when a column is empty", () => {
    render(<OrderBoard orders={[]} onMove={vi.fn()} />);
    expect(screen.getAllByText("Nothing here")).toHaveLength(6);
  });

  it("does not blank the board on an unknown currency code", () => {
    // balanceMinor 0 so only the total carries this amount.
    render(
      <OrderBoard orders={[order({ currency: "XYZ", balanceMinor: 0 })]} onMove={vi.fn()} />,
    );
    // Node's ICU formats a well-formed but unknown code rather than throwing,
    // so the assertion is that the amount survives, not on an exact layout.
    const amount = screen.getByText(/600\.00/);
    expect(amount).toHaveTextContent("XYZ");
  });
});
