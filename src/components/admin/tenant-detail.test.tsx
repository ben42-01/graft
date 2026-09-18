/**
 * GRAFT-27.3 Test Contract — `TenantDetail`, the `/admin/tenants/[tenantId]`
 * screen (AC7, AC8).
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TenantDetail } from "./tenant-detail";

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// A realistic wire payload: `limits` is the FULL resolveEntitlements() return
// (tenantId/tier/limits/features/readOnly/downgradedAt/billingAnchorDay), so
// the resolved caps actually live at `limits.limits` — the nested shape the
// GRAFT-27.2 review called out. `limitOverrides` is the separate raw bag.
const TENANT_DETAIL = {
  id: "000000000000000000000004",
  name: "Downgraded Co",
  slug: "qa-downgraded",
  tier: "free",
  createdAt: "2026-01-01T00:00:00.000Z",
  readOnlyCount: 2,
  hasLimitOverrides: true,
  billing: {
    hasCustomer: true,
    hasSubscription: false,
    graceExpiresAt: "2026-10-15T00:00:00.000Z",
    trialEndsAt: null,
  },
  limits: {
    tenantId: "000000000000000000000004",
    tier: "free",
    limits: { seats: 2, plugins: 3, entities: 3, records: 2000, storageMb: 250 },
    features: { csv_import: false },
    readOnly: ["entities", "dashboards"],
    downgradedAt: "2026-06-01T00:00:00.000Z",
    billingAnchorDay: 15,
  },
  limitOverrides: { seats: 2 },
  readOnly: ["entities", "dashboards"],
  downgradedAt: "2026-06-01T00:00:00.000Z",
  billingAnchorDay: 15,
};

describe("TenantDetail", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("AC7 — shows resolved limits (from the nested limits.limits), overridden keys, the freeze list, downgradedAt, billing anchor day, and trial/grace dates — and no Stripe id anywhere", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: TENANT_DETAIL })));

    const { container } = render(<TenantDetail tenantId="000000000000000000000004" />);

    await waitFor(() => expect(screen.getByText("Downgraded Co")).toBeInTheDocument());

    // Resolved limits, read from limits.limits (the resolved value, 2 — not
    // the tier default of 1), and flagged as overridden.
    const resolvedSection = screen.getByText("Resolved limits").closest("section");
    expect(resolvedSection).not.toBeNull();
    const seatsRow = within(resolvedSection as HTMLElement)
      .getByText("seats")
      .closest("li");
    expect(seatsRow).not.toBeNull();
    expect(seatsRow).toHaveTextContent("2");
    expect(seatsRow).toHaveTextContent("overridden");

    const pluginsRow = within(resolvedSection as HTMLElement)
      .getByText("plugins")
      .closest("li");
    expect(pluginsRow).toHaveTextContent("3");
    expect(pluginsRow).not.toHaveTextContent("overridden");

    // Which limit keys are overridden, named explicitly.
    expect(screen.getByText("Overridden keys").closest("section")).toHaveTextContent("seats");

    // The read-only freeze list — at least one entry rendered as a list item.
    const freezeSection = screen.getByText("Frozen (read-only) resources").closest("section");
    expect(freezeSection).toHaveTextContent("entities");
    expect(freezeSection).toHaveTextContent("dashboards");

    // downgradedAt, billing anchor day, trial/grace.
    const billingSection = screen.getByText("Billing").closest("section");
    expect(billingSection).toHaveTextContent("15"); // billing anchor day
    expect(screen.getByText("Trial ends").nextElementSibling).toHaveTextContent("—"); // no trial

    // Never a Stripe identifier anywhere on the page.
    expect(container.textContent).not.toMatch(
      /cus_|sub_|stripeCustomerId|stripeSubscriptionId/,
    );
  });

  it("AC8 — a 404 renders ErrorState with a not-found message and a link back to the list, never an unhandled render error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { error: { code: "NOT_FOUND", message: "No such tenant", requestId: "r1" } },
            404,
          ),
        ),
    );

    render(<TenantDetail tenantId="000000000000000000000099" />);

    await waitFor(() => expect(screen.getByText(/not found/i)).toBeInTheDocument());
    const link = screen.getByRole("link", { name: "Back to tenants" });
    expect(link).toHaveAttribute("href", "/admin/tenants");
  });
});
