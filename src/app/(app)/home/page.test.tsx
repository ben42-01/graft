/**
 * GRAFT-11.5 Test Contract — the authenticated home screen wired to the
 * shared state primitives (AC1) and the gated control pattern (AC3).
 *
 * AC3's two cases were rewritten in the 2026-08-21 UI refinement. They used
 * to pin `tier !== "free"` as the entitlement for "Add entity", but that is
 * not the product's rule: Free is entitled to 3 entities
 * (`TIER_LIMITS.free.entities`) and `createEntity` enforces a quota, never a
 * tier. The tests pinned the bug in place, so they now pin the quota rule
 * the server actually applies — a Free tenant under its limit can add, and
 * any tenant at its limit cannot.
 */
import { render, screen, waitFor } from "@testing-library/react";
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

function stubFetch(entitiesResponse: Response, tier = "free", entityLimit: number | null = 3) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/me")) {
      return Promise.resolve(jsonResponse({ data: meFor(tier, entityLimit) }));
    }
    if (url.includes("/api/v1/entities")) return Promise.resolve(entitiesResponse);
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

describe("AppHomePage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("AC1 — shows the empty state when there are no entities yet", async () => {
    stubFetch(jsonResponse({ data: [] }));

    render(<AppHomePage />);

    await waitFor(() => expect(screen.getByText("No entities yet")).toBeInTheDocument());
  });

  it("AC1 — shows the error state (not a raw error) when the fetch fails", async () => {
    stubFetch(new Response(null, { status: 500 }));

    render(<AppHomePage />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("couldn't load your entities");
  });

  it("AC1 — shows the entity count once loaded", async () => {
    stubFetch(jsonResponse({ data: [{ id: "e1" }, { id: "e2" }] }));

    render(<AppHomePage />);

    await waitFor(() => expect(screen.getByText("You have 2 entities.")).toBeInTheDocument());
  });

  it("AC3 — the gated Add entity control is disabled with an upgrade prompt at the quota", async () => {
    stubFetch(jsonResponse({ data: [{ id: "e1" }, { id: "e2" }, { id: "e3" }] }), "free", 3);

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
    stubFetch(jsonResponse({ data: [{ id: "e1" }] }), "free", 3);

    render(<AppHomePage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Add entity/ })).toBeEnabled(),
    );
    expect(screen.queryByText(/used all/)).not.toBeInTheDocument();
  });

  it("AC3 — an unlimited (null) entity limit never gates", async () => {
    stubFetch(jsonResponse({ data: [{ id: "e1" }, { id: "e2" }] }), "enterprise", null);

    render(<AppHomePage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Add entity/ })).toBeEnabled(),
    );
  });
});
