/**
 * `RecordDialog` — the form that writes a record (2026-08-21 UI refinement).
 *
 * What is pinned: the form is generated from the entity's fields, values are
 * sent typed (a number as a number, not "36"), a blank required field is
 * caught here with the field's own label rather than as a server 400, and
 * editing PATCHes the individual record. Radix `Select` needs pointer APIs
 * jsdom lacks, so choice fields are covered by `record-values.test.ts`.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordDialog } from "./record-dialog";
import type { FieldLike } from "@/lib/entities/record-values";

const FIELDS: FieldLike[] = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "age", label: "Age", type: "number" },
  { key: "active", label: "Active", type: "checkbox" },
];

function stubOk() {
  const fetchMock = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify({ data: { id: "r1" } }), { status: 200 })),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderDialog(editing: { id: string; data: Record<string, unknown> } | null = null) {
  const onSaved = vi.fn();
  render(
    <RecordDialog
      open
      onOpenChange={vi.fn()}
      entityId="e1"
      entityName="Customers"
      fields={FIELDS}
      editing={editing}
      onSaved={onSaved}
    />,
  );
  return { onSaved, user: userEvent.setup() };
}

describe("RecordDialog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders one input per field and POSTs typed values", async () => {
    const fetchMock = stubOk();
    const { user, onSaved } = renderDialog();

    await user.type(screen.getByLabelText(/Name/), "Ada");
    await user.type(screen.getByLabelText(/Age/), "36");
    await user.click(screen.getByLabelText(/Active/));
    await user.click(screen.getByRole("button", { name: "Add record" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/entities/e1/records");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ name: "Ada", age: 36, active: true });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("catches a blank required field before the request, naming it", async () => {
    const fetchMock = stubOk();
    const { user } = renderDialog();

    await user.type(screen.getByLabelText(/Age/), "36");
    await user.click(screen.getByRole("button", { name: "Add record" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Name is required.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PATCHes the record it was opened on, seeded with its stored values", async () => {
    const fetchMock = stubOk();
    const { user } = renderDialog({ id: "r7", data: { name: "Ada", age: 36 } });

    expect(screen.getByLabelText(/Name/)).toHaveValue("Ada");
    await user.clear(screen.getByLabelText(/Name/));
    await user.type(screen.getByLabelText(/Name/), "Grace");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/entities/e1/records/r7");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toMatchObject({ name: "Grace" });
  });

  it("surfaces the server's message when a write is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: "QUOTA_EXCEEDED", message: "Record limit reached." },
            }),
            { status: 403 },
          ),
        ),
      ),
    );
    const { user } = renderDialog();

    await user.type(screen.getByLabelText(/Name/), "Ada");
    await user.click(screen.getByRole("button", { name: "Add record" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Record limit reached.");
    expect(screen.getByRole("link", { name: "View plans" })).toHaveAttribute(
      "href",
      "/account",
    );
  });
});
