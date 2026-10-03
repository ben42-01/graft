/**
 * The orders list — component coverage. What matters: every row names who the
 * order is for and links to both the order and the customer, and the search
 * finds an order by the things an owner actually remembers about it.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { BoardOrder } from "./order-board";
import { filterOrders, OrdersTable } from "./orders-table";

const order = (over: Partial<BoardOrder> = {}): BoardOrder => ({
  id: "0000000000000000000a1b2c",
  status: "confirmed",
  currency: "EUR",
  totalMinor: 5_000,
  balanceMinor: 2_000,
  customerLabel: "Ada Lovelace",
  customerId: "rec-ada",
  sourceLabel: "Fruit box order",
  lineSummary: "Fruit box",
  createdAt: "2026-06-15T09:00:00.000Z",
  ...over,
});

const orders = [
  order(),
  order({
    id: "0000000000000000000d4e5f",
    status: "completed",
    balanceMinor: 0,
    customerLabel: "Grace Hopper",
    customerId: "rec-grace",
    sourceLabel: null,
    lineSummary: "Juice crate",
  }),
  order({
    id: "000000000000000000099999",
    status: "cancelled",
    customerLabel: null,
    customerId: null,
    sourceLabel: null,
    lineSummary: "Veg box",
  }),
];

describe("filterOrders", () => {
  it("searches customer, item, source form and order number", () => {
    expect(filterOrders(orders, "grace", "all")).toHaveLength(1);
    expect(filterOrders(orders, "veg", "all")).toHaveLength(1);
    expect(filterOrders(orders, "fruit box order", "all")).toHaveLength(1);
    expect(filterOrders(orders, "#0A1B2C", "all")).toHaveLength(1);
    expect(filterOrders(orders, "nobody", "all")).toEqual([]);
  });

  it("narrows to a status, or to orders with money still owed", () => {
    expect(filterOrders(orders, "", "completed").map((o) => o.customerLabel)).toEqual([
      "Grace Hopper",
    ]);
    // The cancelled order has a balance on paper, but nobody owes it.
    expect(filterOrders(orders, "", "unpaid").map((o) => o.customerLabel)).toEqual([
      "Ada Lovelace",
    ]);
  });
});

describe("OrdersTable", () => {
  it("names the customer on every row and links to the order and the customer", () => {
    render(<OrdersTable orders={orders} />);

    const row = screen.getByRole("row", { name: /Ada Lovelace/ });
    expect(within(row).getByRole("link", { name: "#0A1B2C" })).toHaveAttribute(
      "href",
      "/operations/orders/0000000000000000000a1b2c",
    );
    expect(within(row).getByRole("link", { name: "Ada Lovelace" })).toHaveAttribute(
      "href",
      "/operations/customers/rec-ada",
    );
    expect(within(row).getByText("via Fruit box order")).toBeInTheDocument();
    expect(within(row).getByText("Confirmed")).toBeInTheDocument();
  });

  it("says so when an order has no customer, and when one is paid", () => {
    render(<OrdersTable orders={orders} />);
    expect(screen.getByText("No customer")).toBeInTheDocument();
    expect(
      within(screen.getByRole("row", { name: /Grace Hopper/ })).getByText("Paid"),
    ).toBeInTheDocument();
  });

  it("filters as you type and says when nothing matches", async () => {
    const user = userEvent.setup();
    render(<OrdersTable orders={orders} />);

    await user.type(screen.getByRole("searchbox", { name: "Search orders" }), "juice");
    expect(screen.getAllByRole("row")).toHaveLength(2); // header + one match
    expect(screen.getByRole("link", { name: "Grace Hopper" })).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Search orders" }), "zzz");
    expect(screen.getByText("No orders match that.")).toBeInTheDocument();
  });

  it("drops the controls for a customer's own history, and states an empty list", () => {
    const { rerender } = render(<OrdersTable orders={orders} bare />);
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();

    rerender(<OrdersTable orders={[]} />);
    expect(screen.getByText("No orders yet.")).toBeInTheDocument();
  });
});
