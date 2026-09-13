/**
 * Configuring payment collection (GRAFT-24 AC11).
 *
 * The panel's whole job is to stop a URL the server will refuse from ever
 * being sent — the same allow-list rule (`isPaymentLinkUrl`), applied here so
 * the builder sees why, inline, rather than as a save that throws.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
