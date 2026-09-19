/**
 * GRAFT-29.3 Test Contract — `ActivityTable`, the `/admin/activities` list
 * (AC1, AC2, AC3, AC4, AC6).
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityTable } from "./activity-table";

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ROW_A = {
  id: "000000000000000000000101",
  tenantId: "000000000000000000000001",
  actorType: "system" as const,
  actorId: null,
  action: "notify.email.sent",
  ok: true,
  at: "2026-01-01T00:00:00.000Z",
  context: { template: "welcome", to: "j***@example.com" },
};

const ROW_B = {
  id: "000000000000000000000102",
  tenantId: "000000000000000000000001",
  actorType: "admin" as const,
  actorId: "000000000000000000000009",
  action: "billing.payment.failed",
  ok: false,
  at: "2026-01-02T00:00:00.000Z",
  context: { amountCents: 1999, currency: "usd", failureCode: "card_declined" },
};

describe("ActivityTable", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("AC1 — renders one row per activity under real column headers, backed by the server response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: [ROW_A, ROW_B], meta: { cursor: null, hasMore: false } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<ActivityTable />);

    await waitFor(() => expect(screen.getByText(/Notify: email/)).toBeInTheDocument());

    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((h) => h.getAttribute("scope"))).toEqual(headers.map(() => "col"));

    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);

    const cellsA = within(rows[0]).getAllByRole("cell");
    expect(cellsA[1]).toHaveTextContent("Notify: email");
    expect(cellsA[2]).toHaveTextContent("system");
    expect(cellsA[3]).toHaveTextContent("Succeeded");

    const cellsB = within(rows[1]).getAllByRole("cell");
    expect(cellsB[1]).toHaveTextContent("Billing: payment");
    expect(cellsB[3]).toHaveTextContent("Failed");
  });

  it("AC1/AC6 — a search term re-queries the server with ?q= (not a client-side filter), and an empty result renders EmptyState", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ data: [ROW_A, ROW_B], meta: { cursor: null, hasMore: false } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: [], meta: { cursor: null, hasMore: false } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<ActivityTable />);
    await waitFor(() => expect(screen.getByText(/Notify: email/)).toBeInTheDocument());

    const search = screen.getByRole("searchbox", { name: "Search activity" });
    fireEvent.change(search, { target: { value: "nonexistent" } });

    await waitFor(
      () => {
        const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("q=nonexistent"));
        expect(call).toBeDefined();
      },
      { timeout: 2000 },
    );

    await waitFor(() => expect(screen.getByText("No activity matches")).toBeInTheDocument());
    expect(screen.getByText("Nothing matches the current filters.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("AC2 — the action filter is a dropdown of exactly the five families plus All, and re-queries with a registered prefix", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: [ROW_A], meta: { cursor: null, hasMore: false } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<ActivityTable />);
    await waitFor(() => expect(screen.getByText(/Notify: email/)).toBeInTheDocument());

    const trigger = screen.getByRole("combobox", { name: "Filter by action" });
    fireEvent.click(trigger);

    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual([
      "All actions",
      "Notify: email",
      "Billing: subscription",
      "Billing: payment",
      "Account",
      "Entity",
    ]);

    fireEvent.click(screen.getByRole("option", { name: "Notify: email" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) =>
        String(c[0]).includes("action=notify.email."),
      );
      expect(call).toBeDefined();
    });
  });

  it("AC3 — 'load more' advances via meta.cursor and never renders a duplicate row", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ data: [ROW_A], meta: { cursor: "cursor-1", hasMore: true } }),
      )
      .mockResolvedValueOnce(
        // The second page re-includes ROW_A (a server oddity or a race) — the
        // client must still never show it twice.
        jsonResponse({ data: [ROW_A, ROW_B], meta: { cursor: null, hasMore: false } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<ActivityTable />);
    await waitFor(() => expect(screen.getByText(/Notify: email/)).toBeInTheDocument());

    const loadMore = screen.getByRole("button", { name: "Load more" });
    fireEvent.click(loadMore);

    await waitFor(() => expect(screen.getByText(/Billing: payment/)).toBeInTheDocument());
    expect(screen.getAllByText(/Notify: email/)).toHaveLength(1);

    expect(String(fetchMock.mock.calls[1][0])).toContain("cursor=cursor-1");
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("AC4 — a pre-filled tenantId pre-fills and locks the tenant filter, sending it on every request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: [ROW_A], meta: { cursor: null, hasMore: false } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<ActivityTable initialTenantId="000000000000000000000001" />);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) =>
        String(c[0]).includes("tenantId=000000000000000000000001"),
      );
      expect(call).toBeDefined();
    });

    expect(
      screen.getByText(
        (_, node) => node?.textContent === "Filtered to tenant 000000000000000000000001.",
      ),
    ).toBeInTheDocument();

    // Locked: no tenant text input is rendered for the operator to change.
    expect(screen.queryByRole("textbox", { name: /tenant/i })).not.toBeInTheDocument();

    // Changing another filter must keep sending the locked tenantId.
    const trigger = screen.getByRole("combobox", { name: "Filter by actor type" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "Admin" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) =>
          String(c[0]).includes("tenantId=000000000000000000000001") &&
          String(c[0]).includes("actorType=admin"),
      );
      expect(call).toBeDefined();
    });
  });

  it("AC6 — a failed fetch shows ErrorState", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "nope" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    render(<ActivityTable />);

    await waitFor(() => expect(screen.getByText("Couldn't load activity")).toBeInTheDocument());
  });

  it("AC7 — expanding a row shows its context fields with human labels, not raw JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: [ROW_A], meta: { cursor: null, hasMore: false } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<ActivityTable />);
    await waitFor(() => expect(screen.getByText(/Notify: email/)).toBeInTheDocument());

    expect(screen.queryByText("Template")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show details" }));

    expect(screen.getByText("Template")).toBeInTheDocument();
    expect(screen.getByText("welcome")).toBeInTheDocument();
    expect(screen.getByText("Recipient")).toBeInTheDocument();
    expect(screen.getByText("j***@example.com")).toBeInTheDocument();
  });
});
