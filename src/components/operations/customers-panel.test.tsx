/**
 * The customer list — component coverage: who has ordered, what they have
 * spent and owe, and a search that asks the server rather than the page.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiCustomer } from "@/lib/bms/reads";
import { customerName, CustomersPanel } from "./customers-panel";

const customer = (over: Partial<ApiCustomer> = {}): ApiCustomer => ({
  id: "rec-ada",
  entityId: "e1",
  name: "Ada Lovelace",
  email: "ada@example.test",
  phone: "0151",
  recordIds: ["rec-ada"],
  orderCount: 3,
  openOrderCount: 1,
  money: [{ currency: "EUR", bookedMinor: 10_000, paidMinor: 5_000, outstandingMinor: 5_000 }],
  firstOrderAt: "2026-05-01T09:00:00.000Z",
  lastOrderAt: "2026-06-14T09:00:00.000Z",
  ...over,
});

function stub(data: ApiCustomer[], meta = { total: data.length, truncated: false }) {
  const fetchMock = vi.fn((_url: string) =>
    Promise.resolve(new Response(JSON.stringify({ data, meta }), { status: 200 })),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("customerName", () => {
  it("falls back from name to email to phone, and never to nothing", () => {
    expect(customerName({ name: null, email: "a@b.test", phone: null })).toBe("a@b.test");
    expect(customerName({ name: null, email: null, phone: "0151" })).toBe("0151");
    expect(customerName({ name: null, email: null, phone: null })).toBe("Unnamed customer");
  });
});

describe("CustomersPanel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists each customer with their orders, spend and what they owe", async () => {
    stub([customer()]);
    render(<CustomersPanel />);

    const link = await screen.findByRole("link", { name: "Ada Lovelace" });
    expect(link).toHaveAttribute("href", "/operations/customers/rec-ada");
    const row = screen.getByRole("row", { name: /Ada Lovelace/ });
    expect(within(row).getByText("1 open")).toBeInTheDocument();
    expect(within(row).getByText("ada@example.test")).toBeInTheDocument();
    expect(within(row).getByText(/100\.00/)).toBeInTheDocument();
    expect(within(row).getByText(/50\.00/)).toBeInTheDocument();
    expect(screen.getByText("1 customer")).toBeInTheDocument();
  });

  it("searches and sorts on the server", async () => {
    const user = userEvent.setup();
    const fetchMock = stub([customer()]);
    render(<CustomersPanel />);
    await screen.findByRole("link", { name: "Ada Lovelace" });

    await user.type(screen.getByRole("searchbox", { name: "Search customers" }), "ada");
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("q=ada"))).toBe(true),
    );

    await user.selectOptions(screen.getByRole("combobox", { name: "Sort customers" }), "spend");
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("sort=spend"))).toBe(
        true,
      ),
    );
  });

  it("says when the list is longer than the page, and when it is built from a window", async () => {
    stub([customer()], { total: 240, truncated: true });
    render(<CustomersPanel />);
    expect(await screen.findByText(/Showing 1 of 240 customers/)).toBeInTheDocument();
    expect(screen.getByText(/5,000 most recent orders/)).toBeInTheDocument();
  });

  it("explains an empty list, and reports a failed read as an error", async () => {
    stub([]);
    const { unmount } = render(<CustomersPanel />);
    expect(await screen.findByText("No customers yet")).toBeInTheDocument();
    unmount();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    render(<CustomersPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("couldn't load your customers");
  });
});
