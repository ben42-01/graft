import { describe, expect, it } from "vitest";
import { inviteEmail, orderPaymentEmail, verificationEmail } from "./messages";

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
