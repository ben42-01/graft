/**
 * `NewFormDialog`. The contract it has to honour: `fields` names entity
 * field *keys* (a form cannot invent a field), slug and visibility are fixed
 * at creation, and a form that omits a required entity field could never
 * produce a valid record — so it is refused here rather than at submit time
 * by a stranger filling it in.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewFormDialog, type EntityOption } from "./new-form-dialog";

const ENTITIES: EntityOption[] = [
  {
    id: "e1",
    name: "Customers",
    fields: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "phone", label: "Phone", type: "phone", required: false },
    ],
  },
];

function renderDialog() {
  const onCreated = vi.fn();
  render(
    <NewFormDialog
      open
      onOpenChange={vi.fn()}
      entities={ENTITIES}
      defaultEntityId="e1"
      onCreated={onCreated}
    />,
  );
  return { onCreated, user: userEvent.setup() };
}

describe("NewFormDialog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("derives the slug from the name and posts field key references", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: { id: "f1", name: "Book a table" } }), {
          status: 201,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { user, onCreated } = renderDialog();

    await user.type(
      screen.getByLabelText(/^Name$/, { selector: "#form-name" }),
      "Book a table",
    );
    expect(screen.getByLabelText(/URL slug/)).toHaveValue("book-a-table");

    await user.click(screen.getByRole("button", { name: "Create form" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/forms");
    expect(JSON.parse(init.body as string)).toEqual({
      entityId: "e1",
      name: "Book a table",
      slug: "book-a-table",
      visibility: "public",
      fields: [{ key: "name" }, { key: "phone" }],
    });
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith({ id: "f1", name: "Book a table" }),
    );
  });

  it("blocks a form that leaves out a field the entity requires", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { user } = renderDialog();

    await user.type(screen.getByLabelText(/^Name$/, { selector: "#form-name" }), "Partial");
    await user.click(screen.getByRole("checkbox", { name: "Name" }));

    expect(screen.getByText(/is required on this entity/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create form" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a quota refusal with a route to the plan page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: "QUOTA_EXCEEDED", message: "Form limit reached." },
            }),
            { status: 403 },
          ),
        ),
      ),
    );
    const { user } = renderDialog();

    await user.type(screen.getByLabelText(/^Name$/, { selector: "#form-name" }), "Another");
    await user.click(screen.getByRole("button", { name: "Create form" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Form limit reached.");
    expect(screen.getByRole("link", { name: "View plans" })).toHaveAttribute(
      "href",
      "/account",
    );
  });
});
