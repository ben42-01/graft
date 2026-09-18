/**
 * GRAFT-27.3 Test Contract — the admin console's own gate (AC2, AC3, AC4, AC9).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AdminLayout from "./layout";

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }),
}));

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => "/admin/tenants",
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AdminLayout", () => {
  beforeEach(() => {
    replace.mockClear();
  });

  it("AC9 — never imports AppShell, TenantSwitcher, or useMe, so the tenant and admin shells cannot quietly converge", () => {
    const source = readFileSync(
      join(process.cwd(), "src/app/(admin)/admin/layout.tsx"),
      "utf8",
    );
    // Only the actual `import` statements are asserted on — the module docs
    // above name AppShell/TenantSwitcher/useMe deliberately, to explain what
    // this layout is NOT, so a bare substring match would false-positive on
    // its own documentation.
    const importLines = source
      .split("\n")
      .filter((line) => /^import\b/.test(line.trim()))
      .join("\n");
    expect(importLines).not.toMatch(/AppShell/);
    expect(importLines).not.toMatch(/TenantSwitcher/);
    expect(importLines).not.toMatch(/useMe/);
    expect(importLines).not.toMatch(/@\/components\/shell\/app-shell/);
    expect(importLines).not.toMatch(/@\/components\/shell\/tenant-switcher/);
    expect(importLines).not.toMatch(/@\/lib\/session/);
  });

  it("AC4 — while the probe is in flight, only a loading state renders — no admin chrome or data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

    render(
      <AdminLayout>
        <div>tenant data</div>
      </AdminLayout>,
    );

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByText("tenant data")).not.toBeInTheDocument();
    expect(screen.queryByText("Platform admin")).not.toBeInTheDocument();

    vi.unstubAllGlobals();
  });

  it("AC3 — no session (401) redirects to /login with the path preserved, and never renders children", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

    render(
      <AdminLayout>
        <div>tenant data</div>
      </AdminLayout>,
    );

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/login?redirect=%2Fadmin%2Ftenants"),
    );
    expect(screen.queryByText("tenant data")).not.toBeInTheDocument();

    vi.unstubAllGlobals();
  });

  it("AC2 — a non-admin's probe 404s, is sent to /, and no admin/tenant detail ever renders", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { error: { code: "NOT_FOUND", message: "Not found", requestId: "r1" } },
            404,
          ),
        ),
    );

    render(
      <AdminLayout>
        <div>tenant data</div>
      </AdminLayout>,
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(screen.queryByText("tenant data")).not.toBeInTheDocument();
    expect(screen.queryByText(/not an admin/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Platform admin")).not.toBeInTheDocument();

    vi.unstubAllGlobals();
  });

  it("authenticated — renders the admin chrome and children, and never redirects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: { userId: "u1", email: "admin@example.test", isPlatformAdmin: true },
        }),
      ),
    );

    render(
      <AdminLayout>
        <div>tenant data</div>
      </AdminLayout>,
    );

    await waitFor(() => expect(screen.getByText("tenant data")).toBeInTheDocument());
    expect(screen.getByText("Platform admin")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
