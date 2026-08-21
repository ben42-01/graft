/**
 * The account panel (2026-08-21 UI refinement). What matters is that every
 * row in it goes somewhere real — the panel's whole reason for existing is
 * that users look here for settings — and that sign-out still works.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UserMenu } from "./user-menu";
import type { MeResponse } from "@/lib/session";

const setTheme = vi.fn();
vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme }),
}));
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
}));

const ME: MeResponse = {
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

async function openPanel() {
  const user = userEvent.setup();
  render(<UserMenu me={ME} onLogOut={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Open user menu" }));
  return user;
}

describe("UserMenu", () => {
  it("shows who and where you are, including the plan", async () => {
    await openPanel();

    expect(screen.getByText("owner@example.test")).toBeInTheDocument();
    expect(screen.getByText("First Co")).toBeInTheDocument();
    expect(screen.getByText("owner")).toBeInTheDocument();
    expect(screen.getByText("Free")).toBeInTheDocument();
  });

  it("every settings row links to a real destination", async () => {
    await openPanel();

    expect(screen.getByRole("link", { name: /General/ })).toHaveAttribute("href", "/account");
    expect(screen.getByRole("link", { name: /Privacy & data/ })).toHaveAttribute(
      "href",
      "/account/privacy",
    );
    expect(screen.getByRole("link", { name: /Privacy statement/ })).toHaveAttribute(
      "href",
      "/privacy",
    );
    expect(screen.getByRole("link", { name: /Help & feedback/ })).toHaveAttribute(
      "href",
      expect.stringContaining("mailto:team.agora.hub@gmail.com"),
    );
  });

  it("offers System as a theme, which a two-way toggle cannot express", async () => {
    const user = await openPanel();

    const systemButton = screen.getByRole("button", { name: "System" });
    expect(systemButton).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Dark" }));
    expect(setTheme).toHaveBeenCalledWith("dark");
  });

  it("signs out and returns to the login page", async () => {
    const onLogOut = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<UserMenu me={ME} onLogOut={onLogOut} />);
    await user.click(screen.getByRole("button", { name: "Open user menu" }));

    await user.click(screen.getByRole("button", { name: /Log out/ }));

    await waitFor(() => expect(onLogOut).toHaveBeenCalled());
    expect(replace).toHaveBeenCalledWith("/login");
  });
});
