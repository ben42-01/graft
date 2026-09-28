/**
 * `ActivityMonitor` — `/admin/activities`. Carries forward the GRAFT-29.3
 * claims the old `ActivityTable` tests made (server-side filtering, closed
 * family filter, labelled context, de-duplicated paging, tenant pre-filter)
 * and adds the monitor's own: one filter set drives both the summary and the
 * stream, breakdowns filter on click, and the outcome toggle sends `ok`.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityMonitor, type ActivityReport } from "./activity-monitor";

let search = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => search,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const TENANT = "000000000000000000000001";

const ROW_A = {
  id: "000000000000000000000102",
  tenantId: TENANT,
  actorType: "system" as const,
  actorId: null,
  action: "notify.email.sent",
  ok: true,
  at: "2026-01-02T00:00:00.000Z",
  context: { template: "welcome", to: "j***@example.com" },
};

const ROW_B = {
  id: "000000000000000000000101",
  tenantId: TENANT,
  actorType: "admin" as const,
  actorId: "000000000000000000000009",
  action: "billing.payment.failed",
  ok: false,
  at: "2026-01-01T00:00:00.000Z",
  context: { amountCents: 1999, currency: "usd", failureCode: "card_declined" },
};

const REPORT: ActivityReport = {
  range: { from: "2026-01-01T00:00:00.000Z", to: "2026-01-03T00:00:00.000Z", bucket: "day" },
  total: 2,
  ok: 1,
  failed: 1,
  failureRate: 0.5,
  byFamily: [
    { family: "notify.email", total: 1, failed: 0 },
    { family: "billing.payment", total: 1, failed: 1 },
  ],
  byActorType: [{ actorType: "system", total: 1, failed: 0 }],
  topActions: [{ action: "billing.payment.failed", total: 1, failed: 1 }],
  topTenants: [
    {
      tenantId: TENANT,
      tenantName: "Graft Hotel",
      tenantSlug: "graft-hotel",
      total: 2,
      failed: 1,
    },
  ],
  series: [
    { at: "2026-01-01T00:00:00.000Z", ok: 0, failed: 1 },
    { at: "2026-01-02T00:00:00.000Z", ok: 1, failed: 0 },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

type Page = { data: unknown[]; meta: { cursor: string | null; hasMore: boolean } };

/** Routes by path: the summary always answers REPORT; the list answers `pages` in order. */
function mockApi(
  pages: Page[] = [{ data: [ROW_A, ROW_B], meta: { cursor: null, hasMore: false } }],
) {
  let listCall = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/v1/admin/activities/summary"))
      return json({ data: REPORT, meta: {} });
    const pageBody = pages[Math.min(listCall, pages.length - 1)];
    listCall += 1;
    return json(pageBody);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const urls = (fetchMock: ReturnType<typeof mockApi>, prefix: string) =>
  fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith(prefix));

const LIST = "/api/v1/admin/activities?";
const SUMMARY = "/api/v1/admin/activities/summary";

describe("ActivityMonitor", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    search = new URLSearchParams();
  });

  it("renders the stream with human labels and the summary tiles from the server", async () => {
    mockApi();
    render(<ActivityMonitor />);

    await waitFor(() => expect(screen.getByText(/Notify: email · sent/)).toBeInTheDocument());
    const stream = screen.getAllByRole("table").at(-1)!;
    const rows = within(stream).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Graft Hotel");
    expect(rows[1]).toHaveTextContent("Failed");
    expect(screen.getByText("50.0% failure rate")).toBeInTheDocument();
  });

  it("sends the same filters to the summary and the stream, and search re-queries the server", async () => {
    const fetchMock = mockApi();
    render(<ActivityMonitor />);
    await waitFor(() => expect(screen.getByText(/Notify: email · sent/)).toBeInTheDocument());

    fireEvent.change(screen.getByRole("searchbox", { name: "Search activity" }), {
      target: { value: "welcome" },
    });
    await waitFor(() =>
      expect(urls(fetchMock, LIST).some((u) => u.includes("q=welcome"))).toBe(true),
    );
    await waitFor(() =>
      expect(urls(fetchMock, SUMMARY).some((u) => u.includes("q=welcome"))).toBe(true),
    );
  });

  it("clicking a family breakdown filters by that family's prefix", async () => {
    const fetchMock = mockApi();
    render(<ActivityMonitor />);
    await waitFor(() => expect(screen.getByText("By family")).toBeInTheDocument());

    const panel = screen.getByText("By family").closest("section")!;
    fireEvent.click(within(panel).getByRole("button", { name: /Billing: payment/ }));
    await waitFor(() =>
      expect(urls(fetchMock, LIST).some((u) => u.includes("action=billing.payment."))).toBe(
        true,
      ),
    );
  });

  it("the Failed outcome toggle sends ok=false", async () => {
    const fetchMock = mockApi();
    render(<ActivityMonitor />);
    await waitFor(() => expect(screen.getByText(/Notify: email · sent/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("radio", { name: "Failed" }));
    await waitFor(() =>
      expect(urls(fetchMock, LIST).some((u) => u.includes("ok=false"))).toBe(true),
    );
  });

  it("expanding a row shows labelled context values, never raw JSON", async () => {
    mockApi();
    render(<ActivityMonitor />);
    await waitFor(() =>
      expect(screen.getByText(/Billing: payment · failed/)).toBeInTheDocument(),
    );

    const buttons = screen.getAllByRole("button", { name: "Show details" });
    fireEvent.click(buttons[1]!);
    expect(screen.getByText("Amount").nextElementSibling).toHaveTextContent("19.99");
    expect(screen.getByText("Failure code").nextElementSibling).toHaveTextContent(
      "card_declined",
    );
    expect(screen.queryByText(/amountCents/)).not.toBeInTheDocument();
  });

  it("load more advances by cursor and never renders a duplicate row", async () => {
    const fetchMock = mockApi([
      { data: [ROW_A], meta: { cursor: "c1", hasMore: true } },
      { data: [ROW_A, ROW_B], meta: { cursor: null, hasMore: false } },
    ]);
    render(<ActivityMonitor />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() =>
      expect(screen.getByText(/Billing: payment · failed/)).toBeInTheDocument(),
    );
    expect(screen.getAllByText(/Notify: email · sent/)).toHaveLength(1);
    expect(urls(fetchMock, LIST).some((u) => u.includes("cursor=c1"))).toBe(true);
  });

  it("a ?tenantId= in the URL scopes both reads to that account", async () => {
    search = new URLSearchParams({ tenantId: TENANT });
    const fetchMock = mockApi();
    render(<ActivityMonitor />);
    await waitFor(() => expect(screen.getByText(/Notify: email · sent/)).toBeInTheDocument());

    expect(urls(fetchMock, LIST).every((u) => u.includes(`tenantId=${TENANT}`))).toBe(true);
    expect(urls(fetchMock, SUMMARY).every((u) => u.includes(`tenantId=${TENANT}`))).toBe(true);
  });
});
