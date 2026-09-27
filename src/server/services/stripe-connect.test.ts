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

    await startConnectOnboarding(ctx(), {}, deps);
    expect(deps.stripe.createAccount).toHaveBeenCalledTimes(1);
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
      amountMinor: 10_000,
      currency: "EUR",
      productName: "Deposit — Pontoon boat",
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
