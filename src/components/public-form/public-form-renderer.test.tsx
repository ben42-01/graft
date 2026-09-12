/**
 * PublicFormRenderer — component coverage (GRAFT-10 AC2, AC3). Fetch is
 * mocked at the module boundary; the transactional write itself is proven
 * elsewhere (public-forms.integration.test.ts).
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicFormRenderer } from "./public-form-renderer";
import type { FieldDef } from "@/server/services/entities";

const FIELDS: FieldDef[] = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "subscribe", label: "Subscribe", type: "checkbox", required: false },
];

describe("PublicFormRenderer", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("AC2 — renders a labelled input per field", () => {
    render(
      <PublicFormRenderer
        tenantSlug="acme"
        formSlug="contact"
        fields={FIELDS}
        primaryColor={null}
      />,
    );
    expect(screen.getByLabelText(/Name/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Subscribe" })).toBeInTheDocument();
  });

  it("AC3 — shows a no-reload success state after a valid submit", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { submissionId: "abc" } }),
    });

    const user = userEvent.setup();
    render(
      <PublicFormRenderer
        tenantSlug="acme"
        formSlug="contact"
        fields={FIELDS}
        primaryColor={null}
      />,
    );

    await user.type(screen.getByLabelText(/Name/), "Ada Lovelace");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("received");
    });
  });

  it("AC3 — shows the per-field message the API returned on a validation failure", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: async () => ({
        error: {
          code: "VALIDATION_FAILED",
          message: "Invalid request body",
          details: { source: "body", fields: { name: "Required" } },
        },
      }),
    });

    const user = userEvent.setup();
    render(
      <PublicFormRenderer
        tenantSlug="acme"
        formSlug="contact"
        fields={FIELDS}
        primaryColor={null}
      />,
    );

    await user.type(screen.getByLabelText(/Name/), "x");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(screen.getByText("Required")).toBeInTheDocument();
    });
  });
});

/**
 * The payload, rather than the pixels.
 *
 * An untouched optional input holds `""`, and `""` is not "absent" to the
 * compiled entity schema — it is an invalid date, an invalid phone number and
 * a NaN. Posting the form's raw values therefore 400s a submission whose only
 * sin was leaving an optional field alone, which is what happened to a real
 * booking form. These assert on what goes over the wire.
 */
describe("PublicFormRenderer — what it sends", () => {
  const BOOKING_FIELDS: FieldDef[] = [
    { key: "name", label: "Their name", type: "text", required: true },
    { key: "phone", label: "Phone", type: "phone", required: false },
    { key: "starts_at", label: "From", type: "date", required: true },
    { key: "ends_at", label: "Until", type: "date", required: false },
    { key: "party_size", label: "Party size", type: "number", required: false },
  ];

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { submissionId: "abc" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const sent = () =>
    JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).data;

  async function fillAndSubmit() {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <PublicFormRenderer
        tenantSlug="boats4all"
        formSlug="book-boats"
        fields={BOOKING_FIELDS}
        primaryColor={null}
        timeFields={["starts_at", "ends_at"]}
      />,
    );

    await user.type(screen.getByLabelText(/Their name/), "Ada Lovelace");

    // The date picker, driven the way a keyboard-first visitor drives it.
    await user.click(screen.getByRole("button", { name: "From" }));
    const typed = await screen.findByLabelText("Type a date");
    await user.type(typed, "2026-09-20{Enter}");
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    return user;
  }

  it("omits optional fields the visitor left alone, instead of sending empty strings", async () => {
    await fillAndSubmit();

    const data = sent();
    expect(data).not.toHaveProperty("phone");
    expect(data).not.toHaveProperty("ends_at");
    expect(data).not.toHaveProperty("party_size");
  });

  it("sends what the visitor did answer", async () => {
    await fillAndSubmit();

    const data = sent();
    expect(data.name).toBe("Ada Lovelace");
    expect(data.starts_at).toMatch(/^2026-09-20/);
  });

  it("sends a number as a number, not as the string the input held", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <PublicFormRenderer
        tenantSlug="boats4all"
        formSlug="book-boats"
        fields={[
          { key: "name", label: "Their name", type: "text", required: true },
          { key: "party_size", label: "Party size", type: "number", required: false },
        ]}
        primaryColor={null}
      />,
    );

    await user.type(screen.getByLabelText(/Their name/), "Ada");
    await user.type(screen.getByLabelText(/Party size/), "4");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent().party_size).toBe(4);
  });
});
