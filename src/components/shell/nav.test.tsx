/**
 * `Nav` — the new-tab treatment of the Guide link (2026-09-12).
 *
 * Pinned because the failure is silent: dropping `target`/`rel` still renders
 * a working link, and the regression only shows up as a lost half-built form
 * when somebody opens the guide mid-task.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Nav } from "./nav";

vi.mock("next/navigation", () => ({ usePathname: () => "/home" }));

describe("Nav", () => {
  it("opens Guide in a new tab, safely, and says so to a screen reader", () => {
    render(<Nav />);

    const guide = screen.getByRole("link", { name: /Guide/ });
    expect(guide).toHaveAttribute("href", "/guide");
    expect(guide).toHaveAttribute("target", "_blank");
    // Without `noopener` the opened tab can reach back through `window.opener`.
    expect(guide).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(guide).toHaveAccessibleName(/opens in a new tab/i);
  });

  it("leaves every other destination in the same tab", () => {
    render(<Nav />);

    for (const label of ["Overview", "Entities", "Forms", "Operations", "Plugins", "Account"]) {
      expect(screen.getByRole("link", { name: label })).not.toHaveAttribute("target");
    }
  });

  it("does not close the mobile sheet when the link keeps this tab in place", async () => {
    const onNavigate = vi.fn();
    render(<Nav onNavigate={onNavigate} />);

    await userEvent.click(screen.getByRole("link", { name: /Guide/ }));
    expect(onNavigate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("link", { name: "Entities" }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
