/**
 * GRAFT-11.4 Test Contract — `SessionGate`, the auth-redirect guard (AC4).
 */
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionGate } from "./session-gate";

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }),
}));

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("SessionGate", () => {
  beforeEach(() => {
    replace.mockClear();
  });

  it("AC4 — an unauthenticated visit redirects to /login instead of rendering the shell", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

    render(
      <SessionGate>
        <div>guarded content</div>
      </SessionGate>,
    );

    // Never flashes the chrome — not even momentarily, before the redirect.
    expect(screen.queryByText("guarded content")).not.toBeInTheDocument();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByText("guarded content")).not.toBeInTheDocument();

    vi.unstubAllGlobals();
  });

  it("AC1 — an authenticated visit renders the shell around the guarded content, and never redirects", async () => {
    const me = {
      user: { id: "u1", email: "owner@example.test", name: null, emailVerifiedAt: null },
      memberships: [{ tenantId: "t1", slug: "first", name: "First Co", roles: ["owner"] }],
      tenant: {
        id: "t1",
        name: "First Co",
        slug: "first",
        tier: "free",
        limits: {},
        branding: null,
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: me })));

    render(
      <SessionGate>
        <div>guarded content</div>
      </SessionGate>,
    );

    await waitFor(() => expect(screen.getByText("guarded content")).toBeInTheDocument());
    expect(replace).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
