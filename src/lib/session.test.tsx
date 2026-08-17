/**
 * GRAFT-11.4 Test Contract — `useMe().switchTenant` (AC1: "tenant switch
 * triggers a re-fetch"). Driven through a harness rather than the real
 * `TenantSwitcher` (Radix Select) to avoid jsdom's portal/pointer-capture
 * flakiness for a claim that's really about the hook, not the listbox.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMe, type MeResponse } from "./session";

const ME: MeResponse = {
  user: { id: "u1", email: "owner@example.test", name: null, emailVerifiedAt: null },
  memberships: [
    { tenantId: "t1", slug: "first", name: "First Co", roles: ["owner"] },
    { tenantId: "t2", slug: "second", name: "Second Co", roles: ["member"] },
  ],
  tenant: {
    id: "t1",
    name: "First Co",
    slug: "first",
    tier: "free",
    limits: {},
    branding: null,
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function Harness() {
  const { status, me, switchTenant } = useMe();
  if (status !== "authenticated" || !me) return <div>{status}</div>;
  return (
    <div>
      <div>authenticated:{me.tenant.name}</div>
      <button onClick={() => void switchTenant("t2")}>switch</button>
    </div>
  );
}

describe("useMe", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("AC1 — switching tenant POSTs switch-tenant then re-fetches /me", async () => {
    const switched: MeResponse = {
      ...ME,
      tenant: { ...ME.tenant, id: "t2", name: "Second Co", slug: "second" },
    };
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ data: ME }))
      .mockResolvedValueOnce(jsonResponse({}, 200))
      .mockResolvedValueOnce(jsonResponse({ data: switched }));

    const user = userEvent.setup();
    render(<Harness />);
    await waitFor(() => expect(screen.getByText("authenticated:First Co")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "switch" }));

    await waitFor(() =>
      expect(screen.getByText("authenticated:Second Co")).toBeInTheDocument(),
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/v1/auth/switch-tenant",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ tenantId: "t2" }) }),
    );
    expect(fetch).toHaveBeenNthCalledWith(3, "/api/v1/me", { credentials: "include" });
  });
});
