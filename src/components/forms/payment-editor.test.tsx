/**
 * Configuring payment collection (GRAFT-24 AC11).
 *
 * The panel's whole job is to stop a URL the server will refuse from ever
 * being sent — the same allow-list rule (`isPaymentLinkUrl`), applied here so
 * the builder sees why, inline, rather than as a save that throws.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaymentEditor, type PaymentView } from "./payment-editor";

const props = () => ({
  payment: null as PaymentView | null,
  busy: false,
  onSave: vi.fn(),
});

const enable = () =>
  userEvent.setup().click(screen.getByRole("checkbox", { name: /take payment/i }));

describe("PaymentEditor", () => {
  it("AC11 — saves a pasted Stripe payment link", async () => {
    const p = props();
    render(<PaymentEditor {...p} />);
    await enable();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/payment link/i), "https://buy.stripe.com/abc");
    await user.click(screen.getByRole("button", { name: /save payment/i }));

    expect(p.onSave).toHaveBeenCalledWith({
      mode: "link",
      link: { url: "https://buy.stripe.com/abc" },
      required: false,
    });
  });

  it("AC11 — carries the `required` toggle", async () => {
    const p = props();
    render(<PaymentEditor {...p} />);
    await enable();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/payment link/i), "https://buy.stripe.com/abc");
    await user.click(screen.getByRole("checkbox", { name: /send them straight to payment/i }));
    await user.click(screen.getByRole("button", { name: /save payment/i }));

    expect(p.onSave).toHaveBeenCalledWith(expect.objectContaining({ required: true }));
  });

  it("AC11 — a URL the server would refuse is reported inline and cannot be saved", async () => {
    const p = props();
    render(<PaymentEditor {...p} />);
    await enable();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/payment link/i), "https://evil.test/x");

    expect(screen.getByRole("alert")).toHaveTextContent(/buy\.stripe\.com/i);
    expect(screen.getByRole("button", { name: /save payment/i })).toBeDisabled();
    expect(p.onSave).not.toHaveBeenCalled();
  });

  it("AC11 — turning payment off sends null", async () => {
    const p = {
      ...props(),
      payment: {
        mode: "link" as const,
        link: { url: "https://buy.stripe.com/abc" },
        required: true,
      },
    };
    render(<PaymentEditor {...p} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: /take payment/i }));
    await user.click(screen.getByRole("button", { name: /save payment/i }));

    expect(p.onSave).toHaveBeenCalledWith(null);
  });

  it("shows the link already configured", () => {
    render(
      <PaymentEditor
        {...props()}
        payment={{
          mode: "link",
          link: { url: "https://buy.stripe.com/abc" },
          required: true,
        }}
      />,
    );
    expect(screen.getByLabelText(/payment link/i)).toHaveValue("https://buy.stripe.com/abc");
  });
});

describe("PaymentEditor — Stripe Checkout", () => {
  const connectStatus = (value: {
    connected: boolean;
    chargesEnabled: boolean;
    detailsSubmitted: boolean;
  }) =>
    vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ data: value }), { status: 200 })),
    );

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const chooseCheckout = async () => {
    await enable();
    await userEvent.setup().click(screen.getByRole("radio", { name: /stripe checkout/i }));
  };

  it("saves checkout mode once the connected account can take payments", async () => {
    vi.stubGlobal(
      "fetch",
      connectStatus({ connected: true, chargesEnabled: true, detailsSubmitted: true }),
    );
    const p = props();
    render(<PaymentEditor {...p} hasBooking />);
    await chooseCheckout();

    await screen.findByText(/connected and ready/i);
    await userEvent.setup().click(screen.getByRole("button", { name: /save payment/i }));

    expect(p.onSave).toHaveBeenCalledWith({ mode: "checkout", required: false });
  });

  it("offers to connect Stripe, and will not save checkout until it is", async () => {
    vi.stubGlobal(
      "fetch",
      connectStatus({ connected: false, chargesEnabled: false, detailsSubmitted: false }),
    );
    render(<PaymentEditor {...props()} hasBooking />);
    await chooseCheckout();

    expect(await screen.findByRole("button", { name: "Connect Stripe" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save payment/i })).toBeDisabled();
  });

  it("starts onboarding with a return to this form, never an arbitrary URL", async () => {
    const fetchMock = connectStatus({
      connected: false,
      chargesEnabled: false,
      detailsSubmitted: false,
    });
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(<PaymentEditor {...props()} formId="0123456789abcdef01234567" hasBooking />);
    await chooseCheckout();

    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: { url: "https://connect.stripe.com/setup/x" } }), {
          status: 200,
        }),
      ),
    );
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Connect Stripe" }));

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://connect.stripe.com/setup/x"),
    );
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(String(url)).toBe("/api/v1/payments/stripe-connect/onboarding");
    expect(JSON.parse(String(init!.body))).toEqual({
      returnTo: "/forms/0123456789abcdef01234567",
      country: "IE",
    });
  });

  it("sends the business country chosen before connecting, and hides it once connected", async () => {
    const fetchMock = connectStatus({
      connected: false,
      chargesEnabled: false,
      detailsSubmitted: false,
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
    const { unmount } = render(<PaymentEditor {...props()} hasBooking />);
    await chooseCheckout();

    const picker = await screen.findByLabelText("Where your business is based");
    expect(picker).toHaveValue("IE");
    const user = userEvent.setup();
    await user.selectOptions(picker, "GB");
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: { url: "https://connect.stripe.com/setup/x" } }), {
          status: 200,
        }),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Connect Stripe" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    const [, init] = fetchMock.mock.calls.at(-1)!;
    expect(JSON.parse(String(init!.body))).toMatchObject({ country: "GB" });
    unmount();

    vi.stubGlobal(
      "fetch",
      connectStatus({ connected: true, chargesEnabled: false, detailsSubmitted: false }),
    );
    render(<PaymentEditor {...props()} hasBooking />);
    await chooseCheckout();
    await screen.findByRole("button", { name: "Continue Stripe setup" });
    expect(screen.queryByLabelText("Where your business is based")).not.toBeInTheDocument();
  });

  it("warns that checkout needs bookings to have something to charge", async () => {
    vi.stubGlobal(
      "fetch",
      connectStatus({ connected: true, chargesEnabled: true, detailsSubmitted: true }),
    );
    render(<PaymentEditor {...props()} />);
    await chooseCheckout();

    expect(await screen.findByText(/takes no bookings yet/i)).toBeInTheDocument();
  });

  it("lets the owner drop a half-finished Stripe account and start again", async () => {
    let connected = true;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") connected = false;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: { connected, chargesEnabled: false, detailsSubmitted: false },
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PaymentEditor {...props()} />);
    await chooseCheckout();

    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: /use a different stripe account/i }));

    expect(await screen.findByRole("button", { name: "Connect Stripe" })).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls.find(([, i]) => i?.method === "DELETE")!;
    expect(String(url)).toBe("/api/v1/payments/stripe-connect");
    expect(init?.method).toBe("DELETE");
  });

  it("does not disconnect when the owner cancels the confirmation", async () => {
    const fetchMock = connectStatus({
      connected: true,
      chargesEnabled: false,
      detailsSubmitted: false,
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<PaymentEditor {...props()} />);
    await chooseCheckout();

    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: /use a different stripe account/i }));

    expect(fetchMock.mock.calls.some(([, i]) => i?.method === "DELETE")).toBe(false);
  });
});
