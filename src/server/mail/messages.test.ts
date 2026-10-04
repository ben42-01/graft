import { describe, expect, it } from "vitest";
import {
  inviteEmail,
  orderPaidEmail,
  orderPaidOwnerEmail,
  orderPaymentEmail,
  verificationEmail,
} from "./messages";

const ORDER_ID = "0123456789abcdef01234567";

describe("verificationEmail", () => {
  it("links to the verification page and states the expiry", () => {
    const url = "https://app.example.test/verify-email?token=abc_DEF-123";
    const email = verificationEmail({ url, ttlHours: 24 });
    expect(email.subject).toBe("Confirm your email for Graft");
    expect(email.html).toContain(`href="${url}"`);
    expect(email.text).toContain(url);
    expect(email.text).toContain("24 hours");
  });
});

describe("inviteEmail", () => {
  it("names the business and shows admin as Manager", () => {
    const email = inviteEmail({
      businessName: "Harbour Boats",
      role: "admin",
      url: "https://app.example.test/invite/tok",
      ttlDays: 7,
    });
    expect(email.subject).toBe("You're invited to join Harbour Boats on Graft");
    expect(email.text).toContain("as Manager");
    expect(email.text.toLowerCase()).not.toContain("admin");
    expect(email.text).toContain("7 days");
  });
});

describe("orderPaymentEmail", () => {
  const input = {
    businessName: "Lough Boats",
    customerName: "Ada",
    orderId: ORDER_ID,
    amountMinor: 18_600,
    currency: "EUR",
    payUrl: `https://buy.stripe.com/test_abc?client_reference_id=${ORDER_ID}`,
  };

  it("names the order and amount, links the payment, and is signed by the business", () => {
    const email = orderPaymentEmail(input);
    expect(email.subject).toBe("Payment for your order #234567");
    expect(email.text).toMatch(/^Your order #234567\n\nHi Ada,/);
    expect(email.text).toContain("186");
    expect(email.text).toContain(input.payUrl);
    expect(email.text).toContain("Lough Boats");
  });

  it("greets a customer with no name plainly", () => {
    expect(orderPaymentEmail({ ...input, customerName: null }).text).toContain("\nHi,\n");
  });
});

describe("paid emails", () => {
  const base = {
    businessName: "Lough Boats",
    customerName: "Ada",
    orderId: ORDER_ID,
    paidMinor: 6_600,
    balanceMinor: 12_000,
    currency: "EUR",
    confirmed: true,
  };

  it("tells the customer what was paid, what remains, and signs as the business", () => {
    const email = orderPaidEmail(base);
    expect(email.subject).toBe("Payment received for order #234567");
    expect(email.text).toContain("66");
    expect(email.text).toContain("remaining balance is");
    expect(email.text).toContain("Your order is confirmed.");
    expect(email.text).toContain("Lough Boats");
  });

  it("says paid in full when nothing is owed", () => {
    expect(orderPaidEmail({ ...base, balanceMinor: 0 }).text).toContain("paid in full");
  });

  it("links the owner to the order and escapes tenant-chosen names", () => {
    const email = orderPaidOwnerEmail({
      ...base,
      customerName: "<b>Ada</b>",
      orderUrl: "https://app.example.test/operations/orders/x",
    });
    expect(email.html).toContain('href="https://app.example.test/operations/orders/x"');
    expect(email.html).not.toContain("<b>Ada</b>");
    expect(email.subject).toContain("#234567");
  });
});
