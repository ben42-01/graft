/**
 * GRAFT-11.5 Test Contract — the authenticated home screen wired to the
 * shared state primitives (AC1) and the tier-gated control pattern (AC3).
 */
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppHomePage from "./page";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function meFor(tier: string) {
  return {
    user: { id: "u1", email: "owner@example.test", name: null, emailVerifiedAt: null },
    memberships: [{ tenantId: "t1", slug: "first", name: "First Co", roles: ["owner"] }],
    tenant: { id: "t1", name: "First Co", slug: "first", tier, limits: {}, branding: null },
  };
}

function stubFetch(entitiesResponse: Response, tier = "free") {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/me")) return Promise.resolve(jsonResponse({ data: meFor(tier) }));
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

  it("AC3 — the gated Add entity control is disabled with an upgrade prompt on Free", async () => {
    stubFetch(jsonResponse({ data: [] }), "free");

    render(<AppHomePage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Add entity/ })).toBeDisabled(),
    );
    expect(screen.getByText(/Upgrade to Premium/)).toBeInTheDocument();
  });

  it("AC3 — the gated Add entity control is enabled with no upgrade prompt on Premium", async () => {
    stubFetch(jsonResponse({ data: [] }), "premium");

    render(<AppHomePage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Add entity/ })).toBeEnabled(),
    );
    expect(screen.queryByText(/Upgrade to Premium/)).not.toBeInTheDocument();
  });
});
