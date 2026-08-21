/**
 * The entity page (2026-08-21 UI refinement) — the screen that turns an
 * entity from a row in a picker into something you can use.
 *
 * Covered: records render through the entity's own field definitions, the
 * schema editor is seeded from the saved entity and PATCHes it back, and
 * deleting is confirmed rather than immediate. The record form itself has
 * its own test (`record-dialog.test.tsx`).
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import EntityPage from "./page";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ entityId: "e1" }),
  useRouter: () => ({ push, replace: vi.fn() }),
}));

const ENTITY = {
  id: "e1",
  key: "customers",
  name: "Customers",
  schemaVersion: 1,
  fields: [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "active", label: "Active", type: "checkbox" },
  ],
};

const RECORDS = [
  { id: "r1", data: { name: "Ada", active: true } },
  { id: "r2", data: { name: "Grace", active: false } },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Routes the page's reads; returns the mock so writes can be asserted. */
function stubApi(overrides: { entity?: unknown; records?: unknown[] } = {}) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PATCH" || init?.method === "DELETE") {
      return Promise.resolve(jsonResponse({ data: ENTITY }));
    }
    if (url.includes("/records")) {
      return Promise.resolve(jsonResponse({ data: overrides.records ?? RECORDS }, 200));
    }
    return Promise.resolve(jsonResponse({ data: overrides.entity ?? ENTITY }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("EntityPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    push.mockClear();
  });

  it("renders records as columns taken from the entity's fields", async () => {
    stubApi();
    render(<EntityPage />);

    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    expect(within(table).getByText("Ada")).toBeInTheDocument();
    // A checkbox field reads as Yes/No, not `true`/`false`.
    expect(within(table).getByText("Yes")).toBeInTheDocument();
    expect(within(table).getByText("No")).toBeInTheDocument();
  });

  it("says so when the entity has no records yet", async () => {
    stubApi({ records: [] });
    render(<EntityPage />);

    await waitFor(() => expect(screen.getByText("No records yet")).toBeInTheDocument());
  });

  it("seeds the schema editor from the saved entity and PATCHes changes back", async () => {
    const fetchMock = stubApi();
    const user = userEvent.setup();
    render(<EntityPage />);

    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Fields & settings/ }));

    const nameInput = screen.getByLabelText("Name", { selector: "#entity-rename" });
    expect(nameInput).toHaveValue("Customers");
    await user.clear(nameInput);
    await user.type(nameInput, "Clients");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (call) => (call[1] as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patch).toBeDefined();
      expect(JSON.parse((patch![1] as RequestInit).body as string)).toEqual({
        name: "Clients",
        fields: [
          { key: "name", label: "Name", type: "text", required: true },
          { key: "active", label: "Active", type: "checkbox", required: false },
        ],
      });
    });
  });

  it("warns before a save that would orphan stored data", async () => {
    stubApi();
    const user = userEvent.setup();
    render(<EntityPage />);

    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Fields & settings/ }));
    await user.click(screen.getByRole("button", { name: "Remove Active" }));

    expect(screen.getByText(/Removing active leaves the data/)).toBeInTheDocument();
  });

  it("confirms before deleting the entity, then returns to the list", async () => {
    const fetchMock = stubApi();
    const user = userEvent.setup();
    render(<EntityPage />);

    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Fields & settings/ }));
    await user.click(screen.getByRole("button", { name: /Delete entity/ }));

    // The first click only asks; nothing has been sent yet.
    expect(
      fetchMock.mock.calls.some(
        (call) => (call[1] as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);

    await user.click(screen.getByRole("button", { name: "Delete entity" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/entities"));
  });
});
