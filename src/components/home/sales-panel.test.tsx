/**
 * The sales panel — component coverage. The gate is the property that
 * matters most: a tenant without reports sees a locked card and the request
 * is never made (the server refuses it regardless — sales-report.test.ts).
 */
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiSalesReport } from "@/lib/bms/reads";
import { SalesPanel } from "./sales-panel";

const report = (over: Partial<ApiSalesReport> = {}): ApiSalesReport => ({
  from: "2026-05-16T12:00:00.000Z",
  to: "2026-06-15T12:00:00.000Z",
  currency: "EUR",
  otherCurrencies: [],
  totals: {
    orders: 3,
    cancelled: 0,
    bookedMinor: 17_000,
    collectedMinor: 5_000,
    outstandingMinor: 12_000,
    averageOrderMinor: 5_667,
  },
  series: [
    { date: "2026-06-13", orders: 0, bookedMinor: 0, collectedMinor: 0 },
    { date: "2026-06-14", orders: 2, bookedMinor: 7_000, collectedMinor: 5_000 },
    { date: "2026-06-15", orders: 1, bookedMinor: 10_000, collectedMinor: 0 },
  ],
  topItems: [
    { description: "Juice crate", quantity: 1, revenueMinor: 10_000 },
    { description: "Fruit box", quantity: 3, revenueMinor: 7_000 },
  ],
  bySource: [
    { formId: null, formName: null, orders: 1, bookedMinor: 10_000 },
    { formId: "f1", formName: "Fruit box order", orders: 2, bookedMinor: 7_000 },
  ],
  customers: { total: 2, repeat: 1 },
  ...over,
});

const stub = (body: ApiSalesReport) => {
  const fetchMock = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify({ data: body }), { status: 200 })),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

describe("SalesPanel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows a locked card with a route to upgrade, and makes no request, without reports", () => {
    const fetchMock = stub(report());
    render(<SalesPanel allowed={false} />);

    expect(screen.getByRole("link", { name: "View plans" })).toHaveAttribute(
      "href",
      "/account",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the headline figures, best sellers and sources", async () => {
    stub(report());
    render(<SalesPanel allowed />);

    expect(await screen.findByText("Best sellers")).toBeInTheDocument();
    expect(screen.getByText("Average order").nextElementSibling).toHaveTextContent("56.67");
    expect(screen.getByText("Repeat customers").nextElementSibling).toHaveTextContent("1 of 2");
    expect(screen.getByText("Juice crate")).toBeInTheDocument();
    expect(screen.getByText("3 sold")).toBeInTheDocument();
    expect(screen.getByText("Entered by hand")).toBeInTheDocument();
    expect(screen.getByText("Fruit box order")).toBeInTheDocument();
  });

  it("carries every day's figures in a table, not only in the bars", async () => {
    stub(report());
    render(<SalesPanel allowed />);

    const table = await screen.findByRole("table", { name: "Booked per day, last 30 days" });
    expect(table.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(table).toHaveTextContent("100.00");
  });

  it("names the currencies it left out rather than adding them in", async () => {
    stub(report({ otherCurrencies: ["GBP"] }));
    render(<SalesPanel allowed />);
    expect(await screen.findByText(/Orders in GBP are not included/)).toBeInTheDocument();
  });

  it("states a quiet month and a failed read plainly", async () => {
    stub(report({ totals: { ...report().totals, orders: 0 } }));
    const { unmount } = render(<SalesPanel allowed />);
    expect(await screen.findByText("No orders in the last 30 days.")).toBeInTheDocument();
    unmount();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    render(<SalesPanel allowed />);
    expect(await screen.findByText("Sales are unavailable.")).toBeInTheDocument();
  });
});
