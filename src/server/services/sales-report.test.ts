/**
 * Sales reporting — unit coverage for the two reads behind the Overview.
 *
 * What is pinned: the Premium gate is decided on the server, money is never
 * summed across currencies, cancelled orders are not revenue, a payment counts
 * on the day it was taken, and one tenant's numbers never include another's.
 */
import { describe, expect, it } from "vitest";
import {
  addOrder,
  ctxFor,
  daysAgo,
  depsFor,
  emptyWorld,
  FORM_ID,
  NOW,
  OTHER_TENANT,
  type World,
} from "@/server/testing/bms-fixtures";
import {
  getBusinessSummary,
  getSalesReport,
  leadCurrency,
  MAX_REPORT_DAYS,
  type ReportDeps,
} from "./sales-report";

const ctx = ctxFor();

const deps = (world: World, allowed = true): Partial<ReportDeps> => ({
  ...depsFor(world),
  can: async () => allowed,
  now: () => NOW,
});

function trading(): World {
  const world = emptyWorld();
  // Ada: an old paid order, and a recent part-paid one.
  addOrder(world, {
    createdAt: daysAgo(45),
    totalMinor: 4_000,
    status: "completed",
    paid: [
      { amountMinor: 1_000, at: daysAgo(45) },
      { amountMinor: 3_000, at: daysAgo(3) },
    ],
  });
  addOrder(world, {
    createdAt: daysAgo(3),
    totalMinor: 6_000,
    quantity: 2,
    paid: [{ amountMinor: 2_000, at: daysAgo(3) }],
  });
  // Grace: one draft today, drafted by hand.
  addOrder(world, {
    createdAt: daysAgo(0.1),
    totalMinor: 10_000,
    status: "draft",
    description: "Juice crate",
    viaForm: false,
    data: { first_name: "Grace", email: "grace@example.test" },
  });
  // Cancelled, in another currency, and somebody else's — none of it revenue.
  addOrder(world, { createdAt: daysAgo(2), totalMinor: 50_000, status: "cancelled" });
  addOrder(world, {
    createdAt: daysAgo(2),
    totalMinor: 7_700,
    currency: "GBP",
    data: { first_name: "Linus" },
  });
  addOrder(world, { tenantId: OTHER_TENANT, createdAt: daysAgo(1), totalMinor: 99_900 });
  return world;
}

describe("leadCurrency", () => {
  it("picks the most used currency and names the rest", () => {
    expect(
      leadCurrency([{ currency: "EUR" }, { currency: "GBP" }, { currency: "EUR" }]),
    ).toEqual({
      currency: "EUR",
      otherCurrencies: ["GBP"],
    });
  });

  it("honours an explicit choice, and has nothing to say about no orders", () => {
    expect(leadCurrency([{ currency: "EUR" }], "gbp")).toEqual({
      currency: "GBP",
      otherCurrencies: ["EUR"],
    });
    expect(leadCurrency([])).toEqual({ currency: null, otherCurrencies: [] });
  });
});

describe("getBusinessSummary", () => {
  it("reports the headline figures for the tenant's own orders only", async () => {
    const summary = await getBusinessSummary(ctx, deps(trading()));

    expect(summary.currency).toBe("EUR");
    expect(summary.otherCurrencies).toEqual(["GBP"]);
    expect(summary.orders).toMatchObject({ total: 5, open: 3, last7Days: 4, previous7Days: 0 });
    expect(summary.orders.byStatus).toMatchObject({
      draft: 1,
      confirmed: 2,
      completed: 1,
      cancelled: 1,
    });
    expect(summary.money).toEqual({
      // €40 outstanding on the confirmed order + the €100 draft; GBP excluded.
      outstandingMinor: 14_000,
      bookedLast30DaysMinor: 16_000,
      bookedPrevious30DaysMinor: 4_000,
      collectedLast30DaysMinor: 5_000,
    });
    // Ada (by email), Grace and Linus — and Ada first ordered 45 days ago.
    expect(summary.customers).toEqual({ total: 3, newLast30Days: 2 });
    expect(summary.submissions.last7Days).toBe(3);
    expect(summary.truncated).toBe(false);
  });

  it("is all zeroes, not an error, for a tenant that has sold nothing", async () => {
    const summary = await getBusinessSummary(ctx, deps(emptyWorld()));
    expect(summary.currency).toBeNull();
    expect(summary.orders.total).toBe(0);
    expect(summary.money.outstandingMinor).toBe(0);
    expect(summary.customers.total).toBe(0);
  });

  it("is available without the reports feature", async () => {
    const summary = await getBusinessSummary(ctxFor(undefined, "free"), deps(trading(), false));
    expect(summary.orders.total).toBe(5);
  });
});

describe("getSalesReport", () => {
  it("is refused on the server for a tenant without reports", async () => {
    await expect(getSalesReport(ctx, {}, deps(trading(), false))).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { feature: "reports" },
    });
  });

  it("defaults to the last 30 days and totals one currency", async () => {
    const report = await getSalesReport(ctx, {}, deps(trading()));

    expect(report.to).toEqual(NOW);
    expect(report.from).toEqual(daysAgo(30));
    expect(report.currency).toBe("EUR");
    expect(report.otherCurrencies).toEqual(["GBP"]);
    expect(report.totals).toEqual({
      orders: 2,
      cancelled: 1,
      bookedMinor: 16_000,
      // €20 on the new order plus €30 paid this week against the old one.
      collectedMinor: 5_000,
      outstandingMinor: 14_000,
      averageOrderMinor: 8_000,
    });
    expect(report.byStatus).toMatchObject({
      confirmed: 1,
      draft: 1,
      cancelled: 1,
      completed: 0,
    });
  });

  it("zero-fills the daily series and books a payment on the day it was taken", async () => {
    const report = await getSalesReport(ctx, {}, deps(trading()));

    expect(report.series).toHaveLength(31);
    expect(report.series[0].date).toBe("2026-05-16");
    expect(report.series.at(-1)!.date).toBe("2026-06-15");

    const day = (date: string) => report.series.find((row) => row.date === date)!;
    expect(day("2026-06-12")).toEqual({
      date: "2026-06-12",
      orders: 1,
      bookedMinor: 6_000,
      collectedMinor: 5_000,
    });
    expect(day("2026-06-01")).toMatchObject({ orders: 0, bookedMinor: 0, collectedMinor: 0 });
    // The cancelled order of the 13th is not a sale.
    expect(day("2026-06-13").orders).toBe(0);
  });

  it("ranks items, splits by source form and counts repeat customers", async () => {
    const world = trading();
    addOrder(world, { createdAt: daysAgo(1), totalMinor: 1_000 });
    const report = await getSalesReport(ctx, {}, deps(world));

    expect(report.topItems).toEqual([
      { description: "Juice crate", quantity: 1, revenueMinor: 10_000 },
      { description: "Fruit box", quantity: 3, revenueMinor: 7_000 },
    ]);
    expect(report.bySource).toEqual([
      { formId: null, formName: null, orders: 1, bookedMinor: 10_000 },
      {
        formId: FORM_ID.toHexString(),
        formName: "Fruit box order",
        orders: 2,
        bookedMinor: 7_000,
      },
    ]);
    expect(report.customers).toEqual({ total: 2, repeat: 1 });
  });

  it("reports another currency when asked for it", async () => {
    const report = await getSalesReport(ctx, { currency: "gbp" }, deps(trading()));
    expect(report.currency).toBe("GBP");
    expect(report.totals.bookedMinor).toBe(7_700);
    expect(report.otherCurrencies).toEqual(["EUR"]);
  });

  it("honours an explicit window", async () => {
    const report = await getSalesReport(
      ctx,
      { from: daysAgo(50).toISOString(), to: daysAgo(40).toISOString() },
      deps(trading()),
    );
    expect(report.totals).toMatchObject({
      orders: 1,
      bookedMinor: 4_000,
      collectedMinor: 1_000,
    });
  });

  it("refuses a window that is backwards, malformed or longer than a year", async () => {
    const world = trading();
    for (const query of [
      { from: NOW.toISOString(), to: daysAgo(1).toISOString() },
      { from: "yesterday" },
      { currency: "EURO" },
      { from: daysAgo(MAX_REPORT_DAYS + 2).toISOString(), to: NOW.toISOString() },
    ]) {
      await expect(getSalesReport(ctx, query, deps(world))).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
    }
  });

  it("is empty, not broken, for a window with no orders", async () => {
    const report = await getSalesReport(ctx, {}, deps(emptyWorld()));
    expect(report.currency).toBeNull();
    expect(report.totals).toMatchObject({ orders: 0, bookedMinor: 0, averageOrderMinor: 0 });
    expect(report.topItems).toEqual([]);
  });
});
