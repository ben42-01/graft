/**
 * `NewEntityDialog` — the in-app entity builder (2026-08-21 UI refinement).
 *
 * The three things worth pinning: it writes through the shared
 * `POST /api/v1/entities` endpoint with server-shaped keys derived from the
 * labels, it refuses to submit a draft the server would reject and says why,
 * and a quota refusal surfaces the server's own message with a route to act
 * on it. Radix `Select` needs pointer APIs jsdom doesn't implement, so the
 * per-field type control is left to `field-types.test.ts` (which pins the
 * offered types against the server enum) rather than driven through the DOM.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewEntityDialog } from "./new-entity-dialog";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderDialog(onCreated = vi.fn()) {
  render(<NewEntityDialog open onOpenChange={vi.fn()} onCreated={onCreated} />);
  return { onCreated };
}

describe("NewEntityDialog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates through POST /api/v1/entities with keys derived from the labels", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({ data: { id: "e1", key: "customers", name: "Customers" } }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { onCreated } = renderDialog();

    await user.type(screen.getByLabelText(/^Name$/), "Customers");
    // The default row's label drives its key the same way.
    await user.clear(screen.getByLabelText("Label"));
    await user.type(screen.getByLabelText("Label"), "Email address");
    await user.click(screen.getByRole("button", { name: "Create entity" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/entities");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      key: "customers",
      name: "Customers",
      fields: [{ key: "email_address", label: "Email address", type: "text", required: true }],
    });
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith({ id: "e1", key: "customers", name: "Customers" }),
    );
  });

  it("refuses to submit an unnamed entity, and says what is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();

    expect(screen.getByRole("button", { name: "Create entity" })).toBeDisabled();
    expect(screen.getByText("Give this entity a name.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names the field that is missing a label rather than failing silently", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText(/^Name$/), "Customers");
    await user.clear(screen.getByLabelText("Label"));

    expect(screen.getByText("Every field needs a label.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create entity" })).toBeDisabled();
  });

  it("surfaces a quota refusal with a route to the plan page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(
            { error: { code: "QUOTA_EXCEEDED", message: "Entity limit reached." } },
            403,
          ),
        ),
      ),
    );
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText(/^Name$/), "Customers");
    await user.click(screen.getByRole("button", { name: "Create entity" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Entity limit reached."),
    );
    expect(screen.getByRole("link", { name: "View plans" })).toHaveAttribute(
      "href",
      "/account",
    );
  });
});
