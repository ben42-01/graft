/**
 * The payment link on one order — component coverage: a link the server would
 * refuse never leaves the browser, and a saved one is emailed to the customer
 * by Graft, or copied when there is no address to send to.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OrderPaymentLink, paymentMessage } from "./order-payment-link";

const ORDER_ID = "0123456789abcdef01234567";

const props = (over: Partial<Parameters<typeof OrderPaymentLink>[0]> = {}) => ({
  orderId: ORDER_ID,
  link: null,
  editable: true,
  amountMinor: 18_600,
  currency: "EUR",
  businessName: "Lough Boats",
  customerName: "Ada",
  customerEmail: "ada@example.test",
  onSave: vi.fn(async (): Promise<string | null> => null),
  onSend: vi.fn(async (): Promise<string | null> => null),
  ...over,
});

const saved = {
  url: "https://buy.stripe.com/test_abc",
  payUrl: `https://buy.stripe.com/test_abc?client_reference_id=${ORDER_ID}`,
  setAt: "2026-10-03T09:00:00.000Z",
};

describe("paymentMessage", () => {
  it("names the order, the amount and the link, signed by the business", () => {
    const { subject, body } = paymentMessage({
      businessName: "Lough Boats",
      customerName: "Ada",
      orderId: ORDER_ID,
      amountMinor: 18_600,
      currency: "EUR",
      payUrl: saved.payUrl,
    });
    expect(subject).toBe("Payment for your order #234567");
    expect(body).toMatch(/^Hi Ada,/);
    expect(body).toContain("186");
    expect(body).toContain(saved.payUrl);
    expect(body.trim().endsWith("Lough Boats")).toBe(true);
  });
});

describe("OrderPaymentLink", () => {
  it("saves a pasted Stripe link", async () => {
    const p = props();
    render(<OrderPaymentLink {...p} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/payment link/i), " https://invoice.stripe.com/i/x ");
    await user.click(screen.getByRole("button", { name: /save link/i }));
    expect(p.onSave).toHaveBeenCalledWith("https://invoice.stripe.com/i/x");
  });

  it("refuses a link that is not Stripe's, inline, before it is sent", async () => {
    const p = props();
    render(<OrderPaymentLink {...p} />);
    await userEvent
      .setup()
      .type(screen.getByLabelText(/payment link/i), "https://buy.stripe.com.evil.test/x");
    expect(screen.getByRole("alert")).toHaveTextContent(/not a Stripe link/i);
    expect(screen.getByRole("button", { name: /save link/i })).toBeDisabled();
    expect(p.onSave).not.toHaveBeenCalled();
  });

  it("shows the server's reason when it says no", async () => {
    const p = props({
      onSave: vi.fn(async () => "A cancelled order cannot take a payment link"),
    });
    render(<OrderPaymentLink {...p} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/payment link/i), "https://buy.stripe.com/x");
    await user.click(screen.getByRole("button", { name: /save link/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/cancelled order/i);
  });

  it("has Graft email the customer, rather than opening a mail app", async () => {
    const p = props({ link: saved });
    render(<OrderPaymentLink {...p} />);
    expect(screen.queryByRole("link", { name: /email customer/i })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: /email customer/i }));
    expect(p.onSend).toHaveBeenCalledOnce();
  });

  it("says when the link was emailed, and offers to send it again", () => {
    render(
      <OrderPaymentLink
        {...props({ link: { ...saved, emailedAt: "2026-10-03T10:00:00.000Z" } })}
      />,
    );
    expect(screen.getByText(/emailed to ada@example\.test/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /email again/i })).toBeInTheDocument();
  });

  it("shows why a send failed", async () => {
    const p = props({ link: saved, onSend: vi.fn(async () => "The email couldn't be sent.") });
    render(<OrderPaymentLink {...p} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /email customer/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't be sent/i);
  });

  it("offers copying instead when the order has no email address", async () => {
    // user-event installs its own clipboard; what was copied is read back from it.
    const user = userEvent.setup();
    render(<OrderPaymentLink {...props({ link: saved, customerEmail: null })} />);

    expect(screen.queryByRole("button", { name: /email customer/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /copy link/i }));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(saved.payUrl));
  });

  it("removes the link", async () => {
    const p = props({ link: saved });
    render(<OrderPaymentLink {...p} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /remove/i }));
    expect(p.onSave).toHaveBeenCalledWith(null);
  });

  it("is read-only on an order that is finished", () => {
    render(<OrderPaymentLink {...props({ link: saved, editable: false })} />);
    expect(
      screen.queryByRole("button", { name: /change|remove|email customer/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy link/i })).toBeInTheDocument();
  });
});
