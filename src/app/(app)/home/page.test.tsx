/**
 * The Overview (formerly the authenticated home). Keeps GRAFT-11.5's
 * contract — the shared state primitives (AC1) and the gated control
 * pattern (AC3) — and adds the rule the Overview is built on: every panel
 * degrades independently, so one refused read costs the reader that panel
 * and not the screen.
 *
 * AC3's entitlement is the *quota*, not the tier. Free is entitled to 3
 * entities (`TIER_LIMITS.free.entities`) and `createEntity` enforces a quota,
 * never a tier — an earlier version of these tests pinned `tier !== "free"`
 * and so pinned the bug in place.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppHomePage from "./page";

// The page routes into a newly created entity, so it needs a router.
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function meFor(tier: string, entityLimit: number | null = 3) {
  return {
    user: { id: "u1", email: "owner@example.test", name: null, emailVerifiedAt: null },
    memberships: [{ tenantId: "t1", slug: "first", name: "First Co", roles: ["owner"] }],
    tenant: {
      id: "t1",
      name: "First Co",
      slug: "first",
      tier,
      // The materialised per-tenant limits `/me` reports — what the gate reads.
      limits: { entities: entityLimit },
      branding: null,
    },
  };
}

function order(id: string, status: string, balanceMinor = 0, currency = "USD") {
  return {
    id,
    status,
    currency,
    totalMinor: 10_000,
    balanceMinor,
    customerRecordId: null,
    lineItems: [{ description: "A thing" }],
    createdAt: new Date().toISOString(),
  };
}

type Routes = {
  entities?: Response;
  forms?: Response;
  orders?: Response;
  allocations?: Response;
  pools?: Response;
  records?: Response;
  submissions?: Response;
  summary?: Response;
  sales?: Response;
  inbox?: Response;
  features?: Record<string, boolean>;
  tier?: string;
  entityLimit?: number | null;
};

function stubFetch(routes: Routes = {}) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const reply = (fallback: unknown, override?: Response) =>
      Promise.resolve(override ?? jsonResponse({ data: fallback }));

    // Meters before `/me` — "/api/v1/meters/records" *contains* "/api/v1/me".
    if (url.includes("/api/v1/meters/records")) {
      return reply({ used: 0, limit: null }, routes.records);
    }
    if (url.includes("/api/v1/meters/form_submissions")) {
      return reply({ used: 0, limit: 200 }, routes.submissions);
    }
    if (url.includes("/api/v1/me")) {
      const me = meFor(routes.tier ?? "free", routes.entityLimit ?? 3);
      return reply({ ...me, tenant: { ...me.tenant, features: routes.features ?? {} } });
    }
    if (url.includes("/api/v1/reports/summary")) {
      return routes.summary
        ? Promise.resolve(routes.summary)
        : Promise.reject(new Error("off"));
    }
    if (url.includes("/api/v1/reports/sales")) {
      return routes.sales ? Promise.resolve(routes.sales) : Promise.reject(new Error("off"));
    }
    if (url.includes("/api/v1/submissions")) return reply([], routes.inbox);
    if (url.includes("/api/v1/inventory/allocations")) return reply([], routes.allocations);
    if (url.includes("/api/v1/inventory/pools")) return reply([], routes.pools);
    if (url.includes("/api/v1/orders")) return reply([], routes.orders);
    if (url.includes("/api/v1/forms")) return reply([], routes.forms);
    if (url.includes("/api/v1/entities")) return reply([], routes.entities);
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The strip renders label and value as separate nodes in one tile. */
function tile(label: string): HTMLElement {
  const heading = screen.getByText(label);
  const card = heading.closest('[data-slot="card"]');
  if (!card) throw new Error(`no tile for ${label}`);
  return card as HTMLElement;
}

describe("AppHomePage — the Overview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    push.mockReset();
  });

  it("AC1 — shows the error state (not a raw error) when entities can't be read", async () => {
    stubFetch({ entities: new Response(null, { status: 500 }) });

    render(<AppHomePage />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("couldn't load your overview");
  });

  it("leads a brand-new tenant through setup instead of four empty panels", async () => {
    stubFetch();

    render(<AppHomePage />);

    await waitFor(() => expect(screen.getByText("Getting set up")).toBeInTheDocument());
    expect(screen.getByText("0 of 4 done")).toBeInTheDocument();
    // No operational data — "Today" would have nothing honest to say.
    expect(screen.queryByRole("heading", { name: "Today" })).not.toBeInTheDocument();
  });

  it("shows the day's work once there is any, with the checklist demoted", async () => {
    stubFetch({
      entities: jsonResponse({ data: [{ id: "e1" }] }),
      orders: jsonResponse({ data: [order("o1", "confirmed", 5_000)] }),
    });

    render(<AppHomePage />);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument(),
    );
    // Still unfinished, so it is offered — but no longer the main column.
    expect(screen.getByText("Getting set up")).toBeInTheDocument();
  });

  it("counts only live orders as open, and links the number to where it is acted on", async () => {
    stubFetch({
      entities: jsonResponse({ data: [{ id: "e1" }] }),
      orders: jsonResponse({
        data: [
          order("o1", "confirmed"),
          order("o2", "in_progress"),
          order("o3", "completed"),
          order("o4", "cancelled"),
        ],
      }),
    });

    render(<AppHomePage />);

    await waitFor(() => expect(within(tile("Open orders")).getByText("2")).toBeInTheDocument());
    expect(within(tile("Open orders")).getByRole("link")).toHaveAttribute(
      "href",
      "/operations",
    );
  });

  it("never adds one currency to another — it reports the largest and says there are more", async () => {
    stubFetch({
      entities: jsonResponse({ data: [{ id: "e1" }] }),
      orders: jsonResponse({
        data: [order("o1", "confirmed", 50_000, "USD"), order("o2", "confirmed", 9_900, "EUR")],
      }),
    });

    render(<AppHomePage />);

    await waitFor(() =>
      expect(within(tile("Outstanding")).getByText(/500/)).toBeInTheDocument(),
    );
    expect(within(tile("Outstanding")).getByText("+ 1 other currency")).toBeInTheDocument();
  });

  it("degrades one panel, not the screen, when an operational read is refused", async () => {
    stubFetch({
      entities: jsonResponse({ data: [{ id: "e1" }] }),
      orders: new Response(null, { status: 403 }),
    });

    render(<AppHomePage />);

    // The tile says it has no reading rather than claiming zero open orders…
    await waitFor(() =>
      expect(within(tile("Open orders")).getByText("Unavailable")).toBeInTheDocument(),
    );
    expect(within(tile("Open orders")).getByText("…")).toBeInTheDocument();
    // …and the rest of the Overview is still there.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Getting set up")).toBeInTheDocument();
  });

  it("warns on a metered allowance that is nearly spent", async () => {
    stubFetch({
      entities: jsonResponse({ data: [{ id: "e1" }] }),
      submissions: jsonResponse({ data: { used: 170, limit: 200 } }),
    });

    render(<AppHomePage />);

    await waitFor(() =>
      expect(within(tile("Submissions")).getByText("170")).toBeInTheDocument(),
    );
    expect(within(tile("Submissions")).getByText("of 200 this month")).toBeInTheDocument();
    expect(within(tile("Submissions")).getByRole("link")).toHaveAttribute("href", "/account");
  });

  it("reaches the widget composer without it owning a slot in the nav", async () => {
    stubFetch();

    render(<AppHomePage />);

    await waitFor(() =>
      expect(screen.getByRole("link", { name: /Custom views/ })).toHaveAttribute(
        "href",
        "/dashboards",
      ),
    );
  });

  it("AC3 — the gated Add entity control is disabled with an upgrade prompt at the quota", async () => {
    stubFetch({
      entities: jsonResponse({ data: [{ id: "e1" }, { id: "e2" }, { id: "e3" }] }),
      tier: "free",
      entityLimit: 3,
    });

    render(<AppHomePage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Add entity/ })).toBeDisabled(),
    );
    expect(screen.getByText(/used all 3 entities/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View plans" })).toHaveAttribute(
      "href",
      "/account",
    );
  });

  it("AC3 — a Free tenant under its entity quota can add, with no upgrade prompt", async () => {
    stubFetch({
      entities: jsonResponse({ data: [{ id: "e1" }] }),
      tier: "free",
      entityLimit: 3,
    });

    render(<AppHomePage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Add entity/ })).toBeEnabled(),
    );
    expect(screen.queryByText(/used all/)).not.toBeInTheDocument();
  });

  it("AC3 — an unlimited (null) entity limit never gates", async () => {
    stubFetch({
      entities: jsonResponse({ data: [{ id: "e1" }, { id: "e2" }] }),
      tier: "enterprise",
      entityLimit: null,
    });

    render(<AppHomePage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Add entity/ })).toBeEnabled(),
    );
  });

  describe("the business figures", () => {
    const summary = (over: Record<string, unknown> = {}) =>
      jsonResponse({
        data: {
          currency: "EUR",
          otherCurrencies: [],
          orders: { total: 9, open: 4, byStatus: {}, last7Days: 5, previous7Days: 2 },
          money: {
            outstandingMinor: 14_000,
            bookedLast30DaysMinor: 150_000,
            bookedPrevious30DaysMinor: 100_000,
            collectedLast30DaysMinor: 80_000,
          },
          customers: { total: 12, newLast30Days: 3 },
          submissions: { last7Days: 6 },
          truncated: false,
          ...over,
        },
      });

    const trading = (extra: Routes = {}) =>
      stubFetch({
        entities: jsonResponse({ data: [{ id: "e1" }] }),
        orders: jsonResponse({ data: [order("o1", "confirmed", 5_000, "EUR")] }),
        summary: summary(),
        ...extra,
      });

    it("reports bookings, payments and customers from the server's summary", async () => {
      trading();
      render(<AppHomePage />);

      await waitFor(() =>
        expect(within(tile("Booked · 30 days")).getByText(/1,500/)).toBeInTheDocument(),
      );
      expect(
        within(tile("Booked · 30 days")).getByText("+50% on the 30 days before"),
      ).toBeInTheDocument();
      expect(within(tile("Collected · 30 days")).getByText(/800/)).toBeInTheDocument();
      expect(within(tile("Customers")).getByText("12")).toBeInTheDocument();
      expect(within(tile("Customers")).getByText("3 new in 30 days")).toBeInTheDocument();
      expect(within(tile("Customers")).getByRole("link")).toHaveAttribute(
        "href",
        "/operations?tab=customers",
      );
      expect(
        within(tile("New orders · 7 days")).getByText("2 the week before"),
      ).toBeInTheDocument();
    });

    it("says the figures are unavailable, rather than zero, when the summary is refused", async () => {
      trading({ summary: new Response(null, { status: 500 }) });
      render(<AppHomePage />);

      await waitFor(() =>
        expect(within(tile("Booked · 30 days")).getByText("Unavailable")).toBeInTheDocument(),
      );
      // The rest of the Overview is still there.
      expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
    });

    it("shows a Free tenant the locked sales card and never requests the report", async () => {
      const fetchMock = trading();
      render(<AppHomePage />);

      await waitFor(() =>
        expect(screen.getByText(/sales trend, best sellers/)).toBeInTheDocument(),
      );
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes("/api/v1/reports/sales")),
      ).toBe(false);
      expect(screen.getByRole("heading", { name: "Latest activity" })).toBeInTheDocument();
    });

    it("requests the sales report for a tenant whose plan includes reports", async () => {
      const fetchMock = trading({ features: { reports: true } });
      render(<AppHomePage />);

      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(([url]) => String(url).includes("/api/v1/reports/sales")),
        ).toBe(true),
      );
    });

    it("keeps the sales panel away from a tenant that has sold nothing", async () => {
      stubFetch({ summary: summary({ currency: null }) });
      render(<AppHomePage />);

      await waitFor(() => expect(screen.getByText("Getting set up")).toBeInTheDocument());
      expect(screen.queryByText(/Sales · last 30 days/)).not.toBeInTheDocument();
      expect(within(tile("Booked · 30 days")).getByText("No orders yet")).toBeInTheDocument();
    });
  });
});
