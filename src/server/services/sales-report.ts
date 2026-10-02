/**
 * The business numbers behind the Overview — what was sold, what was paid and
 * who bought it (docs/BMS_EXTENSION.md §2.3; docs/TIERS.md §2.4).
 *
 * Two reads, split along the tier line:
 *
 *   - **`getBusinessSummary` is for every tier.** Headline figures only: what
 *     is open, what is owed, how the last 30 days compare with the 30 before.
 *     A Free tenant running a real business is entitled to know how it is
 *     doing; this is the "is it working" answer, not analysis.
 *   - **`getSalesReport` is Premium** (`reports`). The trend over time, the
 *     best sellers, which form the money came through, how many customers
 *     came back. Refused here, on the server, whatever the UI rendered — the
 *     same rule `reports.ts` applies to the Chart widget.
 *
 * Three decisions worth stating:
 *
 *   - **One currency per report.** Adding euros to pounds produces a number
 *     that is not an amount of anything. The report covers the currency most
 *     of the window's orders are in and names the others, rather than
 *     summing across them.
 *   - **Windows are rolling and days are UTC.** "This month" depends on a
 *     timezone the server does not know; "the last 30 days" does not. The
 *     daily series buckets by UTC date, which can sit an hour or two off a
 *     tenant's own midnight — stated here rather than hidden.
 *   - **"Booked" excludes cancelled orders; "collected" is payments by the
 *     date they were taken.** So a deposit paid today against an order placed
 *     last month counts as collected today, which is what a till would say.
 */
import type { Filter } from "mongodb";
import { z } from "zod";
import type { Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import { parse } from "@/server/http/validate";
import {
  customerGroups,
  ORDER_WINDOW,
  resolveCustomerDeps,
  withCustomers,
  type CustomerDeps,
  type SubmissionDoc,
} from "./customers";
import { can } from "./entitlements";
import {
  ACTIVE_STATUSES,
  ORDER_STATUSES,
  toOrderView,
  type OrderDoc,
  type OrderStatus,
  type OrderView,
} from "./orders";
import { balanceMinor } from "./pricing";

const DAY = 86_400_000;

/** The widest window a sales report will cover. */
export const MAX_REPORT_DAYS = 366;
export const DEFAULT_REPORT_DAYS = 30;
const TOP_ITEMS = 10;

export const salesReportQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/, "Expected a 3-letter currency code")
      .optional(),
  })
  .refine((query) => !query.from || !query.to || query.from < query.to, {
    message: "`from` must be before `to`",
    path: ["from"],
  });

export type ReportDeps = CustomerDeps & {
  can: (ctx: Ctx, feature: "reports") => Promise<boolean>;
  now: () => Date;
};

function resolveDeps(overrides: Partial<ReportDeps> = {}): ReportDeps {
  return {
    ...resolveCustomerDeps(overrides),
    can: overrides.can ?? can,
    now: overrides.now ?? (() => new Date()),
  };
}

const zeroByStatus = () =>
  Object.fromEntries(ORDER_STATUSES.map((status) => [status, 0])) as Record<
    OrderStatus,
    number
  >;

/** The currency most of these orders are in, and whichever others appear. */
export function leadCurrency(
  orders: readonly Pick<OrderView, "currency">[],
  preferred?: string,
): { currency: string | null; otherCurrencies: string[] } {
  const counts = new Map<string, number>();
  for (const order of orders) counts.set(order.currency, (counts.get(order.currency) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([code]) => code);
  const currency = preferred?.toUpperCase() ?? ranked[0] ?? null;
  return { currency, otherCurrencies: ranked.filter((code) => code !== currency) };
}

const within = (at: Date, from: Date, to: Date) => at >= from && at < to;

const booked = (orders: readonly OrderView[]) =>
  orders
    .filter((order) => order.status !== "cancelled")
    .reduce((total, order) => total + order.totalMinor, 0);

/** Every payment taken inside the window, whenever its order was placed. */
const collected = (orders: readonly OrderView[], from: Date, to: Date) =>
  orders.reduce(
    (total, order) =>
      total +
      order.payments
        .filter((payment) => within(new Date(payment.at), from, to))
        .reduce((sum, payment) => sum + payment.amountMinor, 0),
    0,
  );

async function loadOrders(deps: ReportDeps, ctx: Ctx, filter: Filter<OrderDoc>) {
  const docs = await deps.orders.find(ctx, filter, { sort: { _id: -1 }, limit: ORDER_WINDOW });
  return { orders: docs.map(toOrderView), truncated: docs.length >= ORDER_WINDOW };
}

export type BusinessSummary = {
  currency: string | null;
  otherCurrencies: string[];
  orders: {
    total: number;
    open: number;
    byStatus: Record<OrderStatus, number>;
    last7Days: number;
    previous7Days: number;
  };
  money: {
    outstandingMinor: number;
    bookedLast30DaysMinor: number;
    bookedPrevious30DaysMinor: number;
    collectedLast30DaysMinor: number;
  };
  customers: { total: number; newLast30Days: number };
  submissions: { last7Days: number };
  truncated: boolean;
};

export async function getBusinessSummary(
  ctx: Ctx,
  overrides: Partial<ReportDeps> = {},
): Promise<BusinessSummary> {
  const deps = resolveDeps(overrides);
  const now = deps.now();
  const ago = (days: number) => new Date(now.getTime() - days * DAY);

  const [{ orders: all, truncated }, { groups }, submissionsLast7Days] = await Promise.all([
    loadOrders(deps, ctx, {}),
    customerGroups(ctx, deps),
    deps.submissions.count(ctx, { createdAt: { $gte: ago(7) } } as Filter<SubmissionDoc>),
  ]);

  const { currency, otherCurrencies } = leadCurrency(all);
  const orders = all.filter((order) => order.currency === currency);
  const createdIn = (from: Date, to: Date) =>
    orders.filter((order) => within(order.createdAt, from, to));

  const byStatus = zeroByStatus();
  for (const order of all) byStatus[order.status] += 1;

  return {
    currency,
    otherCurrencies,
    orders: {
      total: all.length,
      open: all.filter((order) => ACTIVE_STATUSES.includes(order.status)).length,
      byStatus,
      last7Days: all.filter((order) => order.createdAt >= ago(7)).length,
      previous7Days: all.filter((order) => within(order.createdAt, ago(14), ago(7))).length,
    },
    money: {
      outstandingMinor: orders
        .filter((order) => ACTIVE_STATUSES.includes(order.status))
        .reduce(
          (total, order) => total + balanceMinor(order.totalMinor, order.amountPaidMinor),
          0,
        ),
      bookedLast30DaysMinor: booked(createdIn(ago(30), now)),
      bookedPrevious30DaysMinor: booked(createdIn(ago(60), ago(30))),
      collectedLast30DaysMinor: collected(orders, ago(30), now),
    },
    customers: {
      total: groups.length,
      // Orders are newest first, so a group's last order is its first ever.
      newLast30Days: groups.filter(
        (group) => group.orders[group.orders.length - 1].createdAt >= ago(30),
      ).length,
    },
    submissions: { last7Days: submissionsLast7Days },
    truncated,
  };
}

export type SalesReport = {
  from: Date;
  to: Date;
  currency: string | null;
  otherCurrencies: string[];
  totals: {
    orders: number;
    cancelled: number;
    bookedMinor: number;
    collectedMinor: number;
    outstandingMinor: number;
    averageOrderMinor: number;
  };
  /** One row per UTC day in the window, zero-filled so a chart has no gaps. */
  series: { date: string; orders: number; bookedMinor: number; collectedMinor: number }[];
  byStatus: Record<OrderStatus, number>;
  topItems: { description: string; quantity: number; revenueMinor: number }[];
  bySource: {
    formId: string | null;
    formName: string | null;
    orders: number;
    bookedMinor: number;
  }[];
  customers: { total: number; repeat: number };
  truncated: boolean;
};

const utcDay = (at: Date) => at.toISOString().slice(0, 10);

export async function getSalesReport(
  ctx: Ctx,
  query: unknown,
  overrides: Partial<ReportDeps> = {},
): Promise<SalesReport> {
  const deps = resolveDeps(overrides);
  if (!(await deps.can(ctx, "reports"))) {
    throw new AppError(
      "FORBIDDEN",
      "Sales reports are a Premium feature. Upgrade to see trends and best sellers.",
      { feature: "reports" },
    );
  }

  const parsed = parse(salesReportQuerySchema, query, "query");
  const to = parsed.to ?? deps.now();
  const from = parsed.from ?? new Date(to.getTime() - DEFAULT_REPORT_DAYS * DAY);
  if (to.getTime() - from.getTime() > MAX_REPORT_DAYS * DAY) {
    throw new AppError("VALIDATION_FAILED", "A report covers at most one year", {
      source: "query",
      fields: { from: `At most ${MAX_REPORT_DAYS} days before \`to\`` },
    });
  }

  // Placed in the window, or touched in it — a payment bumps `updatedAt`, so
  // the second arm is what catches money collected against an older order.
  const { orders: loaded, truncated } = await loadOrders(deps, ctx, {
    createdAt: { $lt: to },
    $or: [{ createdAt: { $gte: from } }, { updatedAt: { $gte: from } }],
  } as Filter<OrderDoc>);

  const placed = loaded.filter((order) => within(order.createdAt, from, to));
  const { currency, otherCurrencies } = leadCurrency(placed, parsed.currency);
  const inCurrency = (order: OrderView) => order.currency === currency;
  const orders = placed.filter(inCurrency);
  const live = orders.filter((order) => order.status !== "cancelled");

  const series = new Map<string, SalesReport["series"][number]>();
  for (
    let at = new Date(`${utcDay(from)}T00:00:00.000Z`);
    at < to;
    at = new Date(at.getTime() + DAY)
  ) {
    series.set(utcDay(at), { date: utcDay(at), orders: 0, bookedMinor: 0, collectedMinor: 0 });
  }
  for (const order of live) {
    const day = series.get(utcDay(order.createdAt));
    if (!day) continue;
    day.orders += 1;
    day.bookedMinor += order.totalMinor;
  }
  for (const order of loaded.filter(inCurrency)) {
    for (const payment of order.payments) {
      const at = new Date(payment.at);
      if (!within(at, from, to)) continue;
      const day = series.get(utcDay(at));
      if (day) day.collectedMinor += payment.amountMinor;
    }
  }

  const items = new Map<string, SalesReport["topItems"][number]>();
  for (const order of live) {
    for (const line of order.lineItems) {
      if (line.kind === "discount") continue;
      const row = items.get(line.description) ?? {
        description: line.description,
        quantity: 0,
        revenueMinor: 0,
      };
      row.quantity += line.quantity;
      row.revenueMinor += line.amountMinor;
      items.set(line.description, row);
    }
  }

  const enriched = await withCustomers(ctx, live, deps);
  const sources = new Map<string, SalesReport["bySource"][number]>();
  const perCustomer = new Map<string, number>();
  for (const order of enriched) {
    const key = order.source?.formId ?? "";
    const row = sources.get(key) ?? {
      formId: order.source?.formId ?? null,
      formName: order.source?.formName ?? null,
      orders: 0,
      bookedMinor: 0,
    };
    row.orders += 1;
    row.bookedMinor += order.totalMinor;
    sources.set(key, row);

    if (order.customer) {
      const who = order.customer.email ?? order.customer.recordId;
      perCustomer.set(who, (perCustomer.get(who) ?? 0) + 1);
    }
  }

  const byStatus = zeroByStatus();
  for (const order of orders) byStatus[order.status] += 1;
  const bookedMinor = booked(orders);

  return {
    from,
    to,
    currency,
    otherCurrencies,
    totals: {
      orders: live.length,
      cancelled: byStatus.cancelled,
      bookedMinor,
      collectedMinor: collected(loaded.filter(inCurrency), from, to),
      outstandingMinor: live.reduce(
        (total, order) => total + balanceMinor(order.totalMinor, order.amountPaidMinor),
        0,
      ),
      averageOrderMinor: live.length === 0 ? 0 : Math.round(bookedMinor / live.length),
    },
    series: [...series.values()],
    byStatus,
    topItems: [...items.values()]
      .sort((a, b) => b.revenueMinor - a.revenueMinor)
      .slice(0, TOP_ITEMS),
    bySource: [...sources.values()].sort((a, b) => b.bookedMinor - a.bookedMinor),
    customers: {
      total: perCustomer.size,
      repeat: [...perCustomer.values()].filter((count) => count > 1).length,
    },
    truncated,
  };
}
