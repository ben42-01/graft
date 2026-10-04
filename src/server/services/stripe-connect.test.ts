/**
 * Stripe Connect — onboarding, form checkout and the Connect webhook, against
 * in-memory ports. The rules pinned here are the money rules: the amount comes
 * from the order, a webhook only pays an order when the event came from that
 * tenant's own connected account, and a failed delivery stays retryable.
 */
import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { createContext, type Role } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import type { OrderDoc } from "./orders";
import {
  accountReadiness,
  amountDueMinor,
  createFormCheckout,
  disconnectStripe,
  getConnectStatus,
  handleConnectWebhookEvent,
  startConnectOnboarding,
  type ConnectDeps,
  type ConnectEvent,
  type StripeConnectDoc,
} from "./stripe-connect";

const TENANT = "0000000000000000000000c1";
const OTHER_TENANT = "0000000000000000000000c2";
const ORDER = "0000000000000000000000d1";
const NOW = new Date("2026-09-27T10:00:00.000Z");

const ctx = (roles: Role[] = ["owner"]) =>
  createContext({
    requestId: "req-connect-1",
    tenantId: TENANT,
    userId: "0000000000000000000000e1",
    roles,
    tier: "premium",
  });

const connected = (over: Partial<StripeConnectDoc> = {}): StripeConnectDoc => ({
  accountId: "acct_tenant",
  chargesEnabled: true,
  detailsSubmitted: true,
  updatedAt: NOW,
  ...over,
});

const order = (over: Partial<OrderDoc> = {}) =>
  ({
    _id: new ObjectId(ORDER),
    tenantId: new ObjectId(TENANT),
    currency: "EUR",
    lineItems: [
      {
        kind: "resource",
        description: "Pontoon boat",
        quantity: 1,
        unitAmountMinor: 40_000,
        amountMinor: 40_000,
      },
    ],
    totalMinor: 40_000,
    depositMinor: 10_000,
    amountPaidMinor: 0,
    ...over,
  }) as unknown as OrderDoc & { _id: ObjectId };

function harness(
  state: {
    connect?: Record<string, StripeConnectDoc | null>;
    order?: (OrderDoc & { _id: ObjectId }) | null;
    event?: ConnectEvent;
  } = {},
) {
  const connects: Record<string, StripeConnectDoc | null> = {
    [TENANT]: null,
    [OTHER_TENANT]: null,
    ...state.connect,
  };
  const claimed = new Set<string>();
  const deps: ConnectDeps = {
    stripe: {
      createAccount: vi.fn(async () => ({ id: "acct_new" })),
      createAccountLink: vi.fn(async () => ({ url: "https://connect.stripe.com/setup/x" })),
      retrieveAccount: vi.fn(async () => ({ chargesEnabled: true, detailsSubmitted: true })),
      createCheckoutSession: vi.fn(async () => ({ url: "https://checkout.stripe.com/c/1" })),
      constructEvent: vi.fn(async () => {
        if (!state.event) throw new Error("bad signature");
        return state.event;
      }),
    },
    store: {
      find: vi.fn(async (tenantId: string) =>
        tenantId in connects
          ? { tier: "premium" as const, connect: connects[tenantId]! }
          : null,
      ),
      set: vi.fn(async (tenantId: string, value: StripeConnectDoc | null) => {
        connects[tenantId] = value;
      }),
      findTenantIdByAccount: vi.fn(
        async (accountId: string) =>
          Object.entries(connects).find(([, c]) => c?.accountId === accountId)?.[0] ?? null,
      ),
      findOrder: vi.fn(async () => (state.order === undefined ? order() : state.order)),
    },
    events: {
      claim: vi.fn(async (id: string) => (claimed.has(id) ? false : (claimed.add(id), true))),
      release: vi.fn(async (id: string) => void claimed.delete(id)),
    },
    recordPayment: vi.fn(async () => ({})),
    notifyPaid: vi.fn(async () => {}),
    connectEnv: () => ({
      STRIPE_SECRET_KEY: "sk_test",
      STRIPE_CONNECT_WEBHOOK_SECRET: "whsec",
    }),
    appUrl: () => "https://app.graft.test",
    now: () => NOW,
  };
  return { deps, connects, claimed };
}

describe("getConnectStatus", () => {
  it("reports an unconnected workspace without calling Stripe", async () => {
    const { deps } = harness();
    await expect(getConnectStatus(ctx(), deps)).resolves.toEqual({
      connected: false,
      chargesEnabled: false,
      detailsSubmitted: false,
    });
    expect(deps.stripe.retrieveAccount).not.toHaveBeenCalled();
  });

  it("refreshes an unfinished onboarding from Stripe and stores the answer", async () => {
    const { deps, connects } = harness({
      connect: { [TENANT]: connected({ chargesEnabled: false, detailsSubmitted: false }) },
    });
    const status = await getConnectStatus(ctx(), deps);
    expect(status.chargesEnabled).toBe(true);
    expect(connects[TENANT]?.chargesEnabled).toBe(true);
  });

  it("does not ask Stripe again once the account can take payments", async () => {
    const { deps } = harness({ connect: { [TENANT]: connected() } });
    await getConnectStatus(ctx(), deps);
    expect(deps.stripe.retrieveAccount).not.toHaveBeenCalled();
  });
});

describe("startConnectOnboarding", () => {
  it("is refused to a member — where the money goes is an owner's call", async () => {
    const { deps } = harness();
    await expect(startConnectOnboarding(ctx(["member"]), {}, deps)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("creates the account once, stores it, and comes back to the named form", async () => {
    const { deps, connects } = harness();
    const result = await startConnectOnboarding(
      ctx(),
      { returnTo: "/forms/0123456789abcdef01234567" },
      deps,
    );
    expect(result.url).toBe("https://connect.stripe.com/setup/x");
    expect(connects[TENANT]).toMatchObject({ accountId: "acct_new", chargesEnabled: false });
    expect(deps.stripe.createAccountLink).toHaveBeenCalledWith({
      accountId: "acct_new",
      refreshUrl: "https://app.graft.test/forms/0123456789abcdef01234567?stripe=return",
      returnUrl: "https://app.graft.test/forms/0123456789abcdef01234567?stripe=return",
    });

    await startConnectOnboarding(ctx(), { country: "US" }, deps);
    expect(deps.stripe.createAccount).toHaveBeenCalledTimes(1);
  });

  it("creates the account in the chosen country, Ireland when none is named", async () => {
    const chosen = harness();
    await startConnectOnboarding(ctx(), { country: "GB" }, chosen.deps);
    expect(chosen.deps.stripe.createAccount).toHaveBeenCalledWith({
      tenantId: TENANT,
      country: "GB",
    });

    const unnamed = harness();
    await startConnectOnboarding(ctx(), {}, unnamed.deps);
    expect(unnamed.deps.stripe.createAccount).toHaveBeenCalledWith({
      tenantId: TENANT,
      country: "IE",
    });
  });

  it("refuses a country Stripe cannot take card payments in, before creating anything", async () => {
    const { deps } = harness();
    for (const country of ["IN", "XX", "ie", ""]) {
      await expect(startConnectOnboarding(ctx(), { country }, deps)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
    }
    expect(deps.stripe.createAccount).not.toHaveBeenCalled();
  });
});

describe("accountReadiness", () => {
  const due = (awaiting_action_from: string, status: string) => ({
    awaiting_action_from,
    minimum_deadline: { status },
  });
  const merchant = (status: string) => ({
    merchant: { capabilities: { card_payments: { status } } },
  });

  it("takes payments only once card_payments is active", () => {
    expect(accountReadiness({ configuration: merchant("active") }).chargesEnabled).toBe(true);
    for (const status of ["pending", "restricted", "rejected", "unsupported"]) {
      expect(accountReadiness({ configuration: merchant(status) }).chargesEnabled).toBe(false);
    }
    expect(accountReadiness({}).chargesEnabled).toBe(false);
    expect(accountReadiness({ configuration: { merchant: null } }).chargesEnabled).toBe(false);
  });

  it("counts details as submitted unless the holder owes something now or overdue", () => {
    const submitted = (entries: ReturnType<typeof due>[]) =>
      accountReadiness({ requirements: { entries } }).detailsSubmitted;
    expect(submitted([])).toBe(true);
    expect(submitted([due("stripe", "currently_due"), due("user", "eventually_due")])).toBe(
      true,
    );
    expect(submitted([due("user", "currently_due")])).toBe(false);
    expect(submitted([due("user", "past_due")])).toBe(false);
  });

  it("refuses a return address that is not an in-app forms page", async () => {
    const { deps } = harness();
    for (const returnTo of ["https://evil.test", "//evil.test/forms", "/forms/../admin"]) {
      await expect(startConnectOnboarding(ctx(), { returnTo }, deps)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
    }
  });
});

describe("disconnectStripe", () => {
  it("forgets the account for an owner, and is refused to a member", async () => {
    const { deps, connects } = harness({ connect: { [TENANT]: connected() } });
    await expect(disconnectStripe(ctx(["member"]), deps)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(connects[TENANT]).not.toBeNull();

    await expect(disconnectStripe(ctx(["admin"]), deps)).resolves.toMatchObject({
      connected: false,
    });
    expect(connects[TENANT]).toBeNull();
  });
});

describe("amountDueMinor", () => {
  it("is the deposit when there is one, the total otherwise, less what was paid", () => {
    expect(
      amountDueMinor({ depositMinor: 10_000, totalMinor: 40_000, amountPaidMinor: 0 }),
    ).toBe(10_000);
    expect(
      amountDueMinor({ depositMinor: 0, totalMinor: 40_000, amountPaidMinor: 5_000 }),
    ).toBe(35_000);
    expect(
      amountDueMinor({ depositMinor: 10_000, totalMinor: 40_000, amountPaidMinor: 12_000 }),
    ).toBe(0);
  });
});

describe("createFormCheckout", () => {
  const input = {
    tenantId: TENANT,
    orderId: ORDER,
    submissionId: "0000000000000000000000f1",
    formName: "Book a boat",
    formPath: "/f/harbour/book-a-boat",
    requestId: "req-1",
  };

  it("charges the order's deposit on the tenant's own account, once per order", async () => {
    const { deps } = harness({ connect: { [TENANT]: connected() } });
    await expect(createFormCheckout(input, deps)).resolves.toEqual({
      url: "https://checkout.stripe.com/c/1",
    });
    expect(deps.stripe.createCheckoutSession).toHaveBeenCalledWith({
      accountId: "acct_tenant",
      currency: "EUR",
      lineItems: [{ name: "Deposit — Book a boat", unitAmountMinor: 10_000, quantity: 1 }],
      metadata: {
        graftTenantId: TENANT,
        graftOrderId: ORDER,
        graftSubmissionId: input.submissionId,
      },
      successUrl: "https://app.graft.test/f/harbour/book-a-boat/paid",
      cancelUrl: "https://app.graft.test/f/harbour/book-a-boat",
      idempotencyKey: `graft-form-checkout-${ORDER}`,
    });
  });

  /** What the fake Stripe client was asked to charge, line by line. */
  const sentLines = (deps: ConnectDeps) =>
    vi.mocked(deps.stripe.createCheckoutSession).mock.calls[0]![0].lineItems;
  const sumOf = (lines: { unitAmountMinor: number; quantity: number }[]) =>
    lines.reduce((sum, l) => sum + l.unitAmountMinor * l.quantity, 0);
  const line = (description: string, quantity: number, unitAmountMinor: number) => ({
    kind: "resource",
    description,
    quantity,
    unitAmountMinor,
    amountMinor: quantity * unitAmountMinor,
  });

  it("AC1: itemises a cart charged in full, one Stripe line per order line", async () => {
    const { deps } = harness({
      connect: { [TENANT]: connected() },
      order: order({
        lineItems: [line("A", 2, 500), line("B", 1, 2_200)] as OrderDoc["lineItems"],
        totalMinor: 3_200,
        depositMinor: 0,
      }),
    });
    await createFormCheckout(input, deps);
    const lines = sentLines(deps);
    expect(lines).toEqual([
      { name: "A", unitAmountMinor: 500, quantity: 2 },
      { name: "B", unitAmountMinor: 2_200, quantity: 1 },
    ]);
    expect(sumOf(lines)).toBe(3_200);
  });

  it("AC2: a deposit is one line for the amount due, never itemised", async () => {
    const { deps } = harness({
      connect: { [TENANT]: connected() },
      order: order({
        lineItems: [line("A", 2, 500), line("B", 1, 2_200)] as OrderDoc["lineItems"],
        totalMinor: 3_200,
        depositMinor: 1_000,
      }),
    });
    await createFormCheckout(input, deps);
    expect(sentLines(deps)).toEqual([
      { name: "Deposit — Book a boat", unitAmountMinor: 1_000, quantity: 1 },
    ]);
  });

  it("AC2: after a partial payment the balance is one line, never itemised", async () => {
    const { deps } = harness({
      connect: { [TENANT]: connected() },
      order: order({
        lineItems: [line("A", 2, 500), line("B", 1, 2_200)] as OrderDoc["lineItems"],
        totalMinor: 3_200,
        depositMinor: 0,
        amountPaidMinor: 700,
      }),
    });
    await createFormCheckout(input, deps);
    expect(sentLines(deps)).toEqual([
      { name: "Balance — Book a boat", unitAmountMinor: 2_500, quantity: 1 },
    ]);
  });

  it("AC3: a line whose unit × quantity does not make its amount goes as 1 × its amount", async () => {
    const hire = { ...line("Kayak — 3 days", 2, 1_000), amountMinor: 5_000 };
    const { deps } = harness({
      connect: { [TENANT]: connected() },
      order: order({
        lineItems: [hire, line("Paddle", 2, 250)] as OrderDoc["lineItems"],
        totalMinor: 5_500,
        depositMinor: 0,
      }),
    });
    await createFormCheckout(input, deps);
    const lines = sentLines(deps);
    expect(lines).toEqual([
      { name: "Kayak — 3 days", unitAmountMinor: 5_000, quantity: 1 },
      { name: "Paddle", unitAmountMinor: 250, quantity: 2 },
    ]);
    expect(sumOf(lines)).toBe(5_500);
  });

  it("AC3: the session always sums to the amount due, over randomised orders", async () => {
    // A seeded generator, so a failure reproduces.
    let seed = 0x9e3779b9;
    const rand = (n: number) => {
      seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
      return seed % n;
    };
    for (let run = 0; run < 300; run++) {
      const count = 1 + rand(run % 25 === 0 ? 130 : 8);
      const lineItems = Array.from({ length: count }, (_, i) => {
        const l = line(`Item ${i}`, 1 + rand(5), rand(5_000));
        const roll = rand(10);
        // Duration-priced lines whose amount is not unit × quantity.
        if (roll === 0) return { ...l, amountMinor: l.amountMinor + 1 + rand(900) };
        // A discount: negative, which Stripe cannot take as a line.
        if (roll === 1)
          return { ...l, kind: "discount", unitAmountMinor: -1, amountMinor: -l.quantity };
        return l;
      });
      const totalMinor = Math.max(
        0,
        lineItems.reduce((sum, l) => sum + l.amountMinor, 0),
      );
      const depositMinor = rand(3) === 0 ? Math.floor(totalMinor / 4) : 0;
      const amountPaidMinor = rand(4) === 0 ? rand(Math.max(1, totalMinor)) : 0;
      const o = order({
        lineItems: lineItems as OrderDoc["lineItems"],
        totalMinor,
        depositMinor,
        amountPaidMinor,
      });
      const due = amountDueMinor(o);

      const { deps } = harness({ connect: { [TENANT]: connected() }, order: o });
      await createFormCheckout(input, deps);
      if (due <= 0) {
        expect(deps.stripe.createCheckoutSession).not.toHaveBeenCalled();
        continue;
      }
      const lines = sentLines(deps);
      expect(sumOf(lines)).toBe(due);
      expect(lines.length).toBeLessThanOrEqual(100);
      for (const l of lines) {
        expect(Number.isInteger(l.unitAmountMinor) && l.unitAmountMinor >= 0).toBe(true);
        expect(Number.isInteger(l.quantity) && l.quantity >= 1).toBe(true);
      }
    }
  });

  it("AC4: a single-line order charged in full is one line named after the item", async () => {
    const { deps } = harness({
      connect: { [TENANT]: connected() },
      order: order({ depositMinor: 0 }),
    });
    await createFormCheckout(input, deps);
    expect(sentLines(deps)).toEqual([
      { name: "Pontoon boat", unitAmountMinor: 40_000, quantity: 1 },
    ]);
  });

  it("AC5: more lines than Stripe allows collapse to one line for the full amount", async () => {
    const lineItems = Array.from({ length: 101 }, (_, i) => line(`Item ${i}`, 1, 100));
    const { deps } = harness({
      connect: { [TENANT]: connected() },
      order: order({
        lineItems: lineItems as OrderDoc["lineItems"],
        totalMinor: 10_100,
        depositMinor: 0,
      }),
    });
    await createFormCheckout(input, deps);
    expect(sentLines(deps)).toEqual([
      { name: "Order — Book a boat", unitAmountMinor: 10_100, quantity: 1 },
    ]);
  });

  it("AC5: exactly 100 lines are still itemised", async () => {
    const lineItems = Array.from({ length: 100 }, (_, i) => line(`Item ${i}`, 1, 100));
    const { deps } = harness({
      connect: { [TENANT]: connected() },
      order: order({
        lineItems: lineItems as OrderDoc["lineItems"],
        totalMinor: 10_000,
        depositMinor: 0,
      }),
    });
    await createFormCheckout(input, deps);
    expect(sentLines(deps)).toHaveLength(100);
  });

  it("collapses to one order line when a discount makes itemised lines unsendable", async () => {
    const discount = { ...line("Spring offer", 1, -500), kind: "discount" };
    const { deps } = harness({
      connect: { [TENANT]: connected() },
      order: order({
        lineItems: [line("A", 2, 500), line("B", 1, 2_200), discount] as OrderDoc["lineItems"],
        totalMinor: 2_700,
        depositMinor: 0,
      }),
    });
    await createFormCheckout(input, deps);
    expect(sentLines(deps)).toEqual([
      { name: "Order — Book a boat", unitAmountMinor: 2_700, quantity: 1 },
    ]);
  });

  it("AC6: an itemised session keeps the account, metadata, URLs and idempotency key", async () => {
    const { deps } = harness({
      connect: { [TENANT]: connected() },
      order: order({
        lineItems: [line("A", 2, 500), line("B", 1, 2_200)] as OrderDoc["lineItems"],
        totalMinor: 3_200,
        depositMinor: 0,
      }),
    });
    await createFormCheckout(input, deps);
    expect(deps.stripe.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct_tenant",
        currency: "EUR",
        metadata: {
          graftTenantId: TENANT,
          graftOrderId: ORDER,
          graftSubmissionId: input.submissionId,
        },
        successUrl: "https://app.graft.test/f/harbour/book-a-boat/paid",
        cancelUrl: "https://app.graft.test/f/harbour/book-a-boat",
        idempotencyKey: `graft-form-checkout-${ORDER}`,
      }),
    );
  });

  it("offers nothing while the account cannot take payments", async () => {
    const { deps } = harness({ connect: { [TENANT]: connected({ chargesEnabled: false }) } });
    await expect(createFormCheckout(input, deps)).resolves.toBeNull();
    expect(deps.stripe.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("offers nothing when nothing is due — a zero-rated resource", async () => {
    const { deps } = harness({
      connect: { [TENANT]: connected() },
      order: order({ totalMinor: 0, depositMinor: 0 }),
    });
    await expect(createFormCheckout(input, deps)).resolves.toBeNull();
  });

  it("swallows a Stripe failure: the submission has already been accepted", async () => {
    const { deps } = harness({ connect: { [TENANT]: connected() } });
    vi.mocked(deps.stripe.createCheckoutSession).mockRejectedValue(new Error("card_declined"));
    await expect(createFormCheckout(input, deps)).resolves.toBeNull();
  });
});

describe("handleConnectWebhookEvent", () => {
  const paid = (over: Partial<ConnectEvent> = {}, object: Record<string, unknown> = {}) =>
    ({
      id: "evt_1",
      type: "checkout.session.completed",
      account: "acct_tenant",
      data: {
        object: {
          id: "cs_1",
          payment_status: "paid",
          amount_total: 10_000,
          payment_intent: "pi_1",
          metadata: { graftTenantId: TENANT, graftOrderId: ORDER },
          ...object,
        },
      },
      ...over,
    }) as ConnectEvent;

  it("refuses a delivery without a valid signature", async () => {
    const { deps } = harness();
    await expect(handleConnectWebhookEvent("{}", null, "r", deps)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(handleConnectWebhookEvent("{}", "sig", "r", deps)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("records a paid session on its order, once", async () => {
    const { deps } = harness({ connect: { [TENANT]: connected() }, event: paid() });
    await handleConnectWebhookEvent("{}", "sig", "r", deps);
    await handleConnectWebhookEvent("{}", "sig", "r", deps);

    expect(deps.recordPayment).toHaveBeenCalledTimes(1);
    const [paymentCtx, orderId, body] = vi.mocked(deps.recordPayment).mock.calls[0]!;
    expect(paymentCtx.tenantId).toBe(TENANT);
    expect(orderId).toBe(ORDER);
    expect(body).toEqual({ amountMinor: 10_000, reference: "pi_1" });
    // Told once, with this payment's amount — the duplicate delivery is dropped upstream.
    expect(deps.notifyPaid).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.notifyPaid).mock.calls[0]!.slice(1)).toEqual([ORDER, 10_000]);
  });

  it("sends no paid emails when the payment could not be recorded", async () => {
    const { deps } = harness({ connect: { [TENANT]: connected() }, event: paid() });
    vi.mocked(deps.recordPayment).mockRejectedValue(new AppError("CONFLICT", "cancelled"));
    await handleConnectWebhookEvent("{}", "sig", "r", deps);
    expect(deps.notifyPaid).not.toHaveBeenCalled();
  });

  it("ignores a session whose account is not the tenant's own — metadata alone proves nothing", async () => {
    const { deps } = harness({
      connect: {
        [TENANT]: connected(),
        [OTHER_TENANT]: connected({ accountId: "acct_other" }),
      },
      event: paid({ account: "acct_other" }),
    });
    await handleConnectWebhookEvent("{}", "sig", "r", deps);
    expect(deps.recordPayment).not.toHaveBeenCalled();
  });

  it("ignores a session that is not paid yet", async () => {
    const { deps } = harness({
      connect: { [TENANT]: connected() },
      event: paid({}, { payment_status: "unpaid" }),
    });
    await handleConnectWebhookEvent("{}", "sig", "r", deps);
    expect(deps.recordPayment).not.toHaveBeenCalled();
  });

  it("drops a payment for a cancelled order without asking Stripe to retry", async () => {
    const { deps, claimed } = harness({ connect: { [TENANT]: connected() }, event: paid() });
    vi.mocked(deps.recordPayment).mockRejectedValue(new AppError("CONFLICT", "cancelled"));
    await expect(handleConnectWebhookEvent("{}", "sig", "r", deps)).resolves.toBeUndefined();
    expect(claimed.has("evt_1")).toBe(true);
  });

  it("releases the claim when processing fails, so Stripe's retry is not dropped", async () => {
    const { deps, claimed } = harness({ connect: { [TENANT]: connected() }, event: paid() });
    vi.mocked(deps.recordPayment).mockRejectedValueOnce(new Error("mongo down"));
    await expect(handleConnectWebhookEvent("{}", "sig", "r", deps)).rejects.toThrow(
      "mongo down",
    );
    expect(claimed.has("evt_1")).toBe(false);

    await handleConnectWebhookEvent("{}", "sig", "r", deps);
    expect(deps.recordPayment).toHaveBeenCalledTimes(2);
  });

  it("syncs an account's readiness from account.updated", async () => {
    const { deps, connects } = harness({
      connect: { [TENANT]: connected({ chargesEnabled: false }) },
      event: {
        id: "evt_2",
        type: "account.updated",
        account: "acct_tenant",
        data: { object: { charges_enabled: true, details_submitted: true } },
      },
    });
    await handleConnectWebhookEvent("{}", "sig", "r", deps);
    expect(connects[TENANT]?.chargesEnabled).toBe(true);
  });
});
