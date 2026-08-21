/**
 * The template gallery. The library itself is validated in
 * `src/lib/entity-templates/templates.test.ts`; what matters here is that
 * every template reaches the screen, and that choosing one seeds the create
 * dialog rather than creating anything behind the user's back.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import EntityTemplatesPage from "./page";
import { ENTITY_TEMPLATES, templatesByCategory } from "@/lib/entity-templates";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
}));

describe("EntityTemplatesPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    push.mockClear();
  });

  it("renders every template, under its category heading", () => {
    render(<EntityTemplatesPage />);

    for (const group of templatesByCategory()) {
      // By role: "People" is both a category and a field label on Bookings.
      expect(screen.getByRole("heading", { name: group.category })).toBeInTheDocument();
    }
    expect(screen.getAllByRole("button", { name: /Use this template/ })).toHaveLength(
      ENTITY_TEMPLATES.length,
    );
  });

  it("seeds the create dialog from the chosen template without creating anything yet", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<EntityTemplatesPage />);

    const customers = ENTITY_TEMPLATES.find((template) => template.id === "customers")!;
    const card = screen.getByText(customers.name).closest("div[data-slot='card']");
    await user.click(
      within(card as HTMLElement).getByRole("button", { name: /Use this template/ }),
    );

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    // Scoped by id: every field row has a "Label"/"Key" pair of its own.
    expect(screen.getByLabelText(/^Name$/, { selector: "#entity-name" })).toHaveValue(
      customers.entity.name,
    );
    expect(screen.getByLabelText(/^Key/, { selector: "#entity-key" })).toHaveValue(
      customers.entity.key,
    );
    // One editable row per template field — nothing is locked.
    expect(screen.getAllByTestId("field-row")).toHaveLength(customers.entity.fields.length);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates from the seeded dialog and opens the new entity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ data: { id: "e9", key: "customers", name: "Customers" } }),
            {
              status: 201,
            },
          ),
        ),
      ),
    );
    const user = userEvent.setup();
    render(<EntityTemplatesPage />);

    const cards = screen.getAllByRole("button", { name: /Use this template/ });
    await user.click(cards[0]);
    await user.click(await screen.findByRole("button", { name: "Create entity" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/entities/e9"));
  });
});
