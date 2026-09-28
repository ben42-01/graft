/**
 * PublicFormRenderer — component coverage (GRAFT-10 AC2, AC3). Fetch is
 * mocked at the module boundary; the transactional write itself is proven
 * elsewhere (public-forms.integration.test.ts).
 */
import { render, screen, waitFor, within } from "@testing-library/react";
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

describe("PublicFormRenderer — choosing a resource first", () => {
  const resource = (id: string, name: string) => ({
    id,
    image: { url: `/api/v1/public/media/${id}`, alt: name },
    values: [
      { key: "name", label: "Name", value: name },
      { key: "rate", label: "Daily rate", value: "120" },
    ],
  });

  const catalogueThenSubmit = (items: unknown[]) =>
    vi.fn((input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        String(input).includes("/catalogue")
          ? new Response(JSON.stringify({ data: items, meta: { cursor: null } }), {
              status: 200,
            })
          : new Response(JSON.stringify({ data: { submissionId: "s1" } }), { status: 201 }),
      ),
    );

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const renderCatalogue = (timeFields: string[] = []) =>
    render(
      <PublicFormRenderer
        tenantSlug="harbour"
        formSlug="book-a-boat"
        fields={FIELDS}
        primaryColor={null}
        catalogue={{ selectionKey: null }}
        timeFields={timeFields}
      />,
    );

  it("asks for a resource before any question, then shows only the chosen one and the fields", async () => {
    const user = userEvent.setup();
    const fetchMock = catalogueThenSubmit([resource("a", "Pontoon"), resource("b", "Kayak")]);
    vi.stubGlobal("fetch", fetchMock);
    renderCatalogue();

    await screen.findByRole("button", { name: "Choose Kayak" });
    expect(screen.getByLabelText(/Name/)).not.toBeVisible();
    expect(screen.getByRole("button", { name: "Submit", hidden: true })).not.toBeVisible();

    await user.click(screen.getByRole("button", { name: "Choose Kayak" }));

    // The rest of the catalogue is out of sight; the chosen one sits above the form.
    expect(
      screen.getByRole("button", { name: "Choose Pontoon", hidden: true }),
    ).not.toBeVisible();
    expect(screen.getByRole("button", { name: "Change" })).toBeVisible();
    expect(screen.getByLabelText(/Name/)).toBeVisible();

    await user.type(screen.getByLabelText(/Name/), "Ada");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await screen.findByRole("status");
    const [, init] = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/submissions"),
    )!;
    expect(JSON.parse(String(init!.body))._selection).toBe("b");
  });

  it("goes back to the same list on 'Change', and hides the fields again", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", catalogueThenSubmit([resource("a", "Pontoon")]));
    renderCatalogue();

    await user.click(await screen.findByRole("button", { name: "Choose Pontoon" }));
    await user.click(screen.getByRole("button", { name: "Change" }));

    expect(screen.getByRole("button", { name: "Choose Pontoon" })).toBeVisible();
    expect(screen.getByLabelText(/Name/)).not.toBeVisible();
  });

  it("shows the fields straight away when the catalogue has nothing to choose from", async () => {
    vi.stubGlobal("fetch", catalogueThenSubmit([]));
    renderCatalogue();

    await waitFor(() => expect(screen.getByLabelText(/Name/)).toBeVisible());
    expect(screen.queryByRole("list", { name: "Steps" })).not.toBeInTheDocument();
  });

  it("lets an enquiry go without choosing, but not a booking", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", catalogueThenSubmit([resource("a", "Pontoon")]));
    const { unmount } = renderCatalogue();

    await user.click(await screen.findByRole("button", { name: /without choosing/ }));
    expect(screen.getByLabelText(/Name/)).toBeVisible();
    unmount();

    renderCatalogue(["start"]);
    await screen.findByRole("button", { name: "Choose Pontoon" });
    expect(screen.queryByRole("button", { name: /without choosing/ })).not.toBeInTheDocument();
  });
});

/**
 * GRAFT-30.3 AC4 — a cart line the server refuses. The error names the line
 * by its index in what was sent (`_cart.<i>`); the cart marks that line, keeps
 * the rest, and lets the visitor drop it and send again.
 */
describe("PublicFormRenderer — a refused cart line", () => {
  const item = (id: string, name: string) => ({
    id,
    image: null,
    values: [{ key: "name", label: "Name", value: name }],
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("AC4 — marks the refused line, keeps the cart, and resubmits without it", async () => {
    const user = userEvent.setup();
    const submissions: unknown[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("/submissions")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [item("a", "Loaf"), item("b", "Oven hire")],
              meta: { cursor: null },
            }),
            { status: 200 },
          ),
        );
      }
      submissions.push(JSON.parse(String(init!.body)));
      return Promise.resolve(
        submissions.length === 1
          ? new Response(
              JSON.stringify({
                error: {
                  code: "CONFLICT",
                  message: "Not enough of that item is available for the requested time",
                  details: {
                    fields: { "_cart.1": "Not enough of this item is available for that time" },
                  },
                },
              }),
              { status: 409 },
            )
          : new Response(JSON.stringify({ data: { submissionId: "s1" } }), { status: 201 }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <PublicFormRenderer
        tenantSlug="bakery"
        formSlug="shop"
        fields={FIELDS}
        primaryColor={null}
        catalogue={{ selectionKey: null, multiple: true }}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Add Loaf" }));
    await user.click(screen.getByRole("button", { name: "Add Oven hire" }));
    await user.click(screen.getByRole("button", { name: "Continue to your details" }));
    await user.type(screen.getByLabelText(/Name/), "Ada");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    const cart = within(screen.getByRole("list", { name: "Cart items" }));
    const [loaf, oven] = cart.getAllByRole("listitem");
    await waitFor(() =>
      expect(oven).toHaveAccessibleDescription(
        "Not enough of this item is available for that time",
      ),
    );
    expect(oven).toHaveTextContent("Oven hire");
    expect(loaf).toHaveTextContent("Loaf");
    expect(loaf).not.toHaveAccessibleDescription();
    // Still on the details step, answers intact.
    expect(screen.getByLabelText(/Name/)).toHaveValue("Ada");

    await user.click(cart.getByRole("button", { name: "Remove Oven hire" }));
    expect(
      screen.queryByText("Not enough of this item is available for that time"),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await screen.findByText(/your submission was received/);
    expect(submissions).toHaveLength(2);
    expect((submissions[1] as { _cart: unknown })._cart).toEqual([
      { recordId: "a", quantity: 1 },
    ]);
  });
});
