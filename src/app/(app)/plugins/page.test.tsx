/**
 * The plugins screen — component coverage.
 *
 * The point of this screen is that a capability the tier does not permit is
 * *shown and explained* rather than hidden, so that is what is tested hardest:
 * hiding it would make Premium look identical to Free and leave the upgrade
 * prompt with nothing to point at (GRAFT-11.5 AC3, docs/TIERS.md §5).
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PluginsPage from "./page";

type PluginView = {
  id: string;
  name: string;
  version: string;
  tier: "free" | "premium" | "enterprise";
  eligible: boolean;
  enabled: boolean;
};

const plugin = (over: Partial<PluginView> = {}): PluginView => ({
  id: "contacts",
  name: "Contacts",
  version: "1.0.0",
  tier: "free",
  eligible: true,
  enabled: false,
  ...over,
});

const mockFetch = () => fetch as unknown as ReturnType<typeof vi.fn>;

const listOnce = (plugins: PluginView[]) =>
  mockFetch().mockResolvedValueOnce({
    ok: true,
    json: async () => ({ data: plugins }),
  });

describe("PluginsPage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists the catalogue with each plugin's tier", async () => {
    listOnce([
      plugin(),
      plugin({ id: "invoicing", name: "Invoicing", tier: "premium", eligible: false }),
    ]);
    render(<PluginsPage />);

    expect(await screen.findByText("Contacts")).toBeInTheDocument();
    expect(screen.getByText("Invoicing")).toBeInTheDocument();
    expect(screen.getByText(/Premium · v1\.0\.0/)).toBeInTheDocument();
  });

  it("shows an ineligible plugin disabled, with the reason and a way to upgrade", async () => {
    listOnce([
      plugin({ id: "invoicing", name: "Invoicing", tier: "premium", eligible: false }),
    ]);
    render(<PluginsPage />);

    const button = await screen.findByRole("button", { name: "Turn on" });
    expect(button).toBeDisabled();
    expect(screen.getByText("Invoicing is on Premium.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View plans" })).toHaveAttribute(
      "href",
      "/account",
    );
  });

  it("reports how many are on, against the whole catalogue", async () => {
    listOnce([plugin({ enabled: true }), plugin({ id: "forms", name: "Forms" })]);
    render(<PluginsPage />);

    expect(await screen.findByText(/of 2 enabled/)).toBeInTheDocument();
  });

  it("says that turning one off deletes nothing", async () => {
    listOnce([plugin({ enabled: true })]);
    render(<PluginsPage />);

    expect(
      await screen.findByText(/nothing you have already entered is deleted/i),
    ).toBeInTheDocument();
  });

  it("enables a plugin and reloads the catalogue", async () => {
    const user = userEvent.setup();
    listOnce([plugin()]);
    mockFetch().mockResolvedValueOnce({ ok: true, json: async () => ({ data: {} }) });
    listOnce([plugin({ enabled: true })]);

    render(<PluginsPage />);
    await user.click(await screen.findByRole("button", { name: "Turn on" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Turn off" })).toBeInTheDocument();
    });
    expect(mockFetch()).toHaveBeenCalledWith(
      "/api/v1/plugins/contacts/enable",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("surfaces the server's own refusal rather than a generic failure", async () => {
    const user = userEvent.setup();
    listOnce([plugin()]);
    mockFetch().mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: { message: "You have reached your plan's limit." } }),
    });

    render(<PluginsPage />);
    await user.click(await screen.findByRole("button", { name: "Turn on" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You have reached your plan's limit.",
    );
  });

  it("shows an error state when the catalogue cannot be loaded", async () => {
    mockFetch().mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    render(<PluginsPage />);

    expect(await screen.findByText("We couldn't load your plugins.")).toBeInTheDocument();
  });
});
