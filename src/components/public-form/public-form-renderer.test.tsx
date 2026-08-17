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
