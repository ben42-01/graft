/**
 * GRAFT-27.3 Test Contract — `TenantTable`, the `/admin/tenants` list
 * (AC1, AC5, AC6, AC10).
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TenantTable } from "./tenant-table";

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const TENANT_A = {
  id: "000000000000000000000001",
  name: "Graft Hotel",
  slug: "graft-hotel",
  tier: "premium",
  createdAt: "2026-01-01T00:00:00.000Z",
  readOnlyCount: 0,
  hasLimitOverrides: false,
  billing: {
    hasCustomer: true,
    hasSubscription: true,
    graceExpiresAt: null,
    trialEndsAt: null,
  },
};

const TENANT_B = {
  id: "000000000000000000000002",
  name: "Salon Sixty",
  slug: "salon-sixty",
  tier: "free",
  createdAt: "2026-01-02T00:00:00.000Z",
  readOnlyCount: 2,
  hasLimitOverrides: true,
  billing: {
    hasCustomer: false,
    hasSubscription: false,
    graceExpiresAt: "2026-10-01T00:00:00.000Z",
    trialEndsAt: null,
  },
};

describe("TenantTable", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("AC1/AC10 — renders one row per tenant with name, slug, tier, freeze, and trial/grace, under real column headers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: [TENANT_A, TENANT_B], meta: { cursor: null, hasMore: false } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<TenantTable />);

    await waitFor(() => expect(screen.getByText("Graft Hotel")).toBeInTheDocument());

    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((h) => h.getAttribute("scope"))).toEqual(headers.map(() => "col"));
    expect(headers.map((h) => h.textContent)).toEqual([
      "Name",
      "Slug",
      "Tier",
      "Freeze",
      "Trial / grace",
    ]);

    const rows = screen.getAllByRole("row").slice(1); // drop the header row
    expect(rows).toHaveLength(2);

    const cellsA = within(rows[0]).getAllByRole("cell");
    expect(cellsA[0]).toHaveTextContent("Graft Hotel");
    expect(cellsA[1]).toHaveTextContent("graft-hotel");
    expect(cellsA[2]).toHaveTextContent("premium");
    expect(cellsA[3]).toHaveTextContent("—"); // no freeze
    expect(cellsA[4]).toHaveTextContent("—"); // no trial/grace

    const cellsB = within(rows[1]).getAllByRole("cell");
    expect(cellsB[0]).toHaveTextContent("Salon Sixty");
    expect(cellsB[3]).toHaveTextContent("Frozen (2)");
    expect(cellsB[4]).toHaveTextContent(/Grace until/);
  });

  it("AC5 — a search term re-queries the server with ?q= (not a client-side filter), and an empty result renders EmptyState", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ data: [TENANT_A, TENANT_B], meta: { cursor: null, hasMore: false } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: [], meta: { cursor: null, hasMore: false } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<TenantTable />);
    await waitFor(() => expect(screen.getByText("Graft Hotel")).toBeInTheDocument());

    const search = screen.getByRole("searchbox", { name: "Search tenants" });
    fireEvent.change(search, { target: { value: "nonexistent" } });

    await waitFor(
      () => {
        const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("q=nonexistent"));
        expect(call).toBeDefined();
      },
      { timeout: 2000 },
    );

    await waitFor(() => expect(screen.getByText("No tenants match")).toBeInTheDocument());
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("AC6 — 'load more' advances via meta.cursor and never renders a duplicate row", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ data: [TENANT_A], meta: { cursor: "cursor-1", hasMore: true } }),
      )
      .mockResolvedValueOnce(
        // The second page re-includes TENANT_A (a server oddity or a race) —
        // the client must still never show it twice.
        jsonResponse({ data: [TENANT_A, TENANT_B], meta: { cursor: null, hasMore: false } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<TenantTable />);
    await waitFor(() => expect(screen.getByText("Graft Hotel")).toBeInTheDocument());

    const loadMore = screen.getByRole("button", { name: "Load more" });
    fireEvent.click(loadMore);

    await waitFor(() => expect(screen.getByText("Salon Sixty")).toBeInTheDocument());
    expect(screen.getAllByText("Graft Hotel")).toHaveLength(1);

    expect(String(fetchMock.mock.calls[1][0])).toContain("cursor=cursor-1");

    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });
});
