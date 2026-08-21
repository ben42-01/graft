/**
 * GRAFT-11.4 Test Contract — `AppShell` (AC1, AC3). Presentational: receives
 * an already-resolved `MeResponse` (see session-gate.test.tsx for the guard).
 * AC2 (375px collapse) is structural-only here (jsdom has no viewport
 * engine) — called out as manual-only in the PR.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./app-shell";
import type { MeResponse } from "@/lib/session";

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/home",
}));

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
    branding: { logoUrl: null, primaryColor: "#4ade80" },
  },
};

describe("AppShell", () => {
  it("AC1/AC3 — renders nav/switcher (scoped to /me's memberships)/user menu, and threads branding", () => {
    const { container } = render(
      <AppShell me={ME} onSwitchTenant={vi.fn()} onLogOut={vi.fn()}>
        <div>content</div>
      </AppShell>,
    );

    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByText("content")).toBeInTheDocument();

    // The switcher trigger shows the *active* tenant, sourced from /me — and
    // Radix renders its listbox lazily, so the trigger alone (not "Second
    // Co") is what's on screen without opening the portal.
    const trigger = screen.getByRole("combobox", { name: "Switch workspace" });
    expect(trigger).toHaveTextContent("First Co");
    expect(within(trigger).queryByText("Second Co")).not.toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Open user menu" })).toBeInTheDocument();

    // AC3 — the branding colour is a CSS var, not a hard-coded panel colour.
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.getPropertyValue("--graft-tenant-accent")).toBe("#4ade80");

    // AC2 — a mobile nav trigger exists, distinct from the desktop rail.
    expect(screen.getByRole("button", { name: "Open navigation" }).className).toContain(
      "sm:hidden",
    );
  });
});
