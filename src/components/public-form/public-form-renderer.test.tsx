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
import type { ContentBlock } from "@/lib/content-blocks";

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
 * GRAFT-24 AC9 — the payment handoff. The submission has already been
 * accepted and written by the time any of this runs: `payment` arrives on the
 * 201, so the only decision left here is where the visitor goes next.
 */
describe("PublicFormRenderer — payment handoff", () => {
  const PAY_URL = "https://buy.stripe.com/abc?client_reference_id=x";

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const respondWith = (payment: unknown) => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { submissionId: "abc", ...(payment ? { payment } : {}) },
      }),
    });
  };

  const submit = async (navigate: (url: string) => void) => {
    const user = userEvent.setup();
    render(
      <PublicFormRenderer
        tenantSlug="acme"
        formSlug="contact"
        fields={FIELDS}
        primaryColor={null}
        navigate={navigate}
      />,
    );
    await user.type(screen.getByLabelText(/Name/), "Ada Lovelace");
    await user.click(screen.getByRole("button", { name: "Submit" }));
  };

  it("AC9 — navigates to the payment URL when payment is required", async () => {
    respondWith({ url: PAY_URL, required: true });
    const navigate = vi.fn();
    await submit(navigate);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(PAY_URL));
  });

  it("AC9 — offers a 'Pay now' link, and does not navigate, when it is optional", async () => {
    respondWith({ url: PAY_URL, required: false });
    const navigate = vi.fn();
    await submit(navigate);

    const link = await screen.findByRole("link", { name: /pay now/i });
    expect(link).toHaveAttribute("href", PAY_URL);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("AC5, AC9 — an ordinary form neither navigates nor offers a link", async () => {
    respondWith(null);
    const navigate = vi.fn();
    await submit(navigate);

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("received"));
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: /pay now/i })).not.toBeInTheDocument();
  });
});

describe("PublicFormRenderer — notes and links for customers", () => {
  const CONTENT: ContentBlock[] = [
    {
      id: "policy",
      kind: "notice",
      title: "Cancellation policy",
      body: "Cancel up to 24 hours before.",
      after: "name",
    },
    {
      id: "site",
      kind: "link",
      label: "Our website",
      url: "https://example.com",
      requireAgreement: false,
      after: null,
    },
    {
      id: "terms",
      kind: "link",
      label: "Terms of hire",
      url: "https://example.com/terms",
      requireAgreement: true,
      after: "subscribe",
    },
  ];

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const renderWithContent = () =>
    render(
      <PublicFormRenderer
        tenantSlug="acme"
        formSlug="contact"
        fields={FIELDS}
        primaryColor={null}
        content={CONTENT}
      />,
    );

  it("places a note where the business put it, as plain text", () => {
    renderWithContent();
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Cancellation policy");
    expect(note).toHaveTextContent("Cancel up to 24 hours before.");

    const name = screen.getByLabelText(/Name/);
    const subscribe = screen.getByRole("checkbox", { name: "Subscribe" });
    expect(name.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      note.compareDocumentPosition(subscribe) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("opens a link in a new tab without handing this page to it", () => {
    renderWithContent();
    const link = screen.getByRole("link", { name: /Our website/ });
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("will not send until the required agreement is ticked, and names it", async () => {
    const user = userEvent.setup();
    renderWithContent();

    await user.type(screen.getByLabelText(/Name/), "Ada Lovelace");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(
      await screen.findByText("Please agree to Terms of hire before sending."),
    ).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends the ticked agreement beside the data, never inside it", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { submissionId: "abc" } }),
    });
    const user = userEvent.setup();
    renderWithContent();

    await user.type(screen.getByLabelText(/Name/), "Ada Lovelace");
    await user.click(screen.getByRole("checkbox", { name: /I agree to/ }));
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(String(init.body));
    expect(body._agreed).toEqual(["terms"]);
    expect(body.data).not.toHaveProperty("terms");
  });
});
