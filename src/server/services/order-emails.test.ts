import { describe, expect, it, vi } from "vitest";
import type { Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import type { OrderWithCustomer } from "./customers";
import {
  PAYMENT_EMAIL_COOLDOWN_MS,
  sendOrderPaymentLink,
  type OrderEmailDeps,
} from "./order-emails";

const TENANT = "000000000000000000000002";
const USER = "00000000000000000000000c";
const ORDER_ID = "0123456789abcdef01234567";
const NOW = new Date("2026-10-04T12:00:00.000Z");
const PAY_URL = `https://buy.stripe.com/test_abc?client_reference_id=${ORDER_ID}`;

const ctx: Ctx = {
  tenantId: TENANT,
  userId: USER,
  roles: ["owner"],
  tier: "premium",
  requestId: "req",
};

const order = (over: Partial<OrderWithCustomer> = {}): OrderWithCustomer =>
  ({
    id: ORDER_ID,
    status: "pending_payment",
    currency: "EUR",
    totalMinor: 18_600,
    amountPaidMinor: 0,
    balanceMinor: 18_600,
    paymentLink: {
      url: "https://buy.stripe.com/test_abc",
      payUrl: PAY_URL,
      setAt: NOW,
      emailedAt: null,
    },
    customer: {
      name: "Ada",
      email: "ada@example.test",
      phone: null,
      recordId: "r",
      entityId: "e",
    },
    source: null,
    ...over,
  }) as OrderWithCustomer;

function deps(current: OrderWithCustomer = order(), over: Partial<OrderEmailDeps> = {}) {
  const sendMail = vi.fn(async () => {});
  const markEmailed = vi.fn(async () => current);
  const d: Partial<OrderEmailDeps> = {
    loadOrder: async () => current,
    accounts: {
      findTenantById: vi.fn(async () => ({ name: "Lough Boats" }) as never),
      findUserById: vi.fn(async () => ({ email: "staff@lough.test" }) as never),
    },
    markEmailed,
    sendMail,
    now: () => NOW,
    ...over,
  };
  return { d, sendMail, markEmailed };
}

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  return "resolved";
};

describe("sendOrderPaymentLink", () => {
  it("emails the customer from the business via Graft, replies to the sender, and stamps it", async () => {
    const { d, sendMail, markEmailed } = deps();
    await sendOrderPaymentLink(ctx, ORDER_ID, d);

    expect(sendMail).toHaveBeenCalledOnce();
    const message = (sendMail.mock.calls[0] as unknown[])[0] as Record<string, string>;
    expect(message).toMatchObject({
      kind: "order.payment_link",
      to: "ada@example.test",
      replyTo: "staff@lough.test",
      fromName: "Lough Boats via Graft",
      subject: "Payment for your order #234567",
    });
    expect(message.text).toContain(PAY_URL);
    expect(markEmailed).toHaveBeenCalledWith(ctx, ORDER_ID);
  });

  it.each([
    ["no link", order({ paymentLink: null })],
    ["no customer email", order({ customer: null })],
    ["nothing left to pay", order({ balanceMinor: 0 })],
    ["a completed order", order({ status: "completed" })],
  ])("refuses %s with CONFLICT and sends nothing", async (_label, current) => {
    const { d, sendMail } = deps(current);
    expect(await refusal(sendOrderPaymentLink(ctx, ORDER_ID, d))).toBe("CONFLICT");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("refuses a resend inside the cooldown, and allows it after", async () => {
    const at = (msAgo: number) =>
      order({
        paymentLink: {
          url: "https://buy.stripe.com/test_abc",
          payUrl: PAY_URL,
          setAt: NOW,
          emailedAt: new Date(NOW.getTime() - msAgo),
        },
      });
    const recent = deps(at(10_000));
    expect(await refusal(sendOrderPaymentLink(ctx, ORDER_ID, recent.d))).toBe("RATE_LIMITED");
    expect(recent.sendMail).not.toHaveBeenCalled();

    const later = deps(at(PAYMENT_EMAIL_COOLDOWN_MS));
    await sendOrderPaymentLink(ctx, ORDER_ID, later.d);
    expect(later.sendMail).toHaveBeenCalledOnce();
  });

  it("reports a failed send without stamping the order", async () => {
    const { d, markEmailed } = deps(order(), {
      sendMail: vi.fn(async () => Promise.reject(new Error("535 Bad credentials"))),
    });
    expect(await refusal(sendOrderPaymentLink(ctx, ORDER_ID, d))).toBe("INTERNAL");
    expect(markEmailed).not.toHaveBeenCalled();
  });

  it("rejects a malformed order id before reading anything", async () => {
    const loadOrder = vi.fn();
    expect(await refusal(sendOrderPaymentLink(ctx, "nope", { loadOrder }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(loadOrder).not.toHaveBeenCalled();
  });
});
