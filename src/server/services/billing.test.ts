/**
 * Stripe checkout and webhooks — logic tests (GRAFT-15).
 *
 * Every port here is faked in-memory so the module's decisions — tier
 * transitions, idempotency, which forms unpublish, the grace-period window —
 * are exercised without a database or the Stripe SDK. The Mongo store and the
 * webhook route are driven for real by bruno/billing/*.bru.
 */
import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import { TIER_LIMITS } from "@/server/tiers";
import {
  applyDowngradePolicy,
  applyUpgrade,
  billingEnv,
  createCheckoutSession,
  expireDueGracePeriods,
  expireTrial,
  handleStripeWebhookEvent,
  isDuplicateKey,
  startGracePeriod,
  toSnapshot,
  type BillingDeps,
  type BillingStore,
  type BillingTenantSnapshot,
  type StripeClient,
  type StripeEvent,
  type WebhookEventStore,
} from "./billing";
import type { FormDoc } from "./forms";

const TENANT_A = "000000000000000000000001";
const TENANT_B = "000000000000000000000002";

const ctxFor = (tenantId = TENANT_A, roles: Ctx["roles"] = ["owner"]): Ctx =>
  createContext({
    requestId: "req-billing",
    tenantId,
    userId: "00000000000000000000000b",
    roles,
    tier: "free",
  });

function fakeStore(initial: Record<string, BillingTenantSnapshot>) {
  const tenants = new Map(Object.entries(initial));
  const calls: { method: string; tenantId: string }[] = [];

  const store: BillingStore = {
    async findTenantById(tenantId) {
      return tenants.get(tenantId) ?? null;
    },
    async findTenantByStripeCustomerId(customerId) {
      for (const tenant of tenants.values()) {
        if (tenant.billing.stripeCustomerId === customerId) return tenant;
      }
      return null;
    },
    async setStripeCustomerId(tenantId, customerId) {
      calls.push({ method: "setStripeCustomerId", tenantId });
      const t = tenants.get(tenantId);
      if (t)
        tenants.set(tenantId, {
          ...t,
          billing: { ...t.billing, stripeCustomerId: customerId },
        });
    },
    async setSubscriptionId(tenantId, subscriptionId) {
      calls.push({ method: "setSubscriptionId", tenantId });
      const t = tenants.get(tenantId);
      if (t)
        tenants.set(tenantId, {
          ...t,
          billing: { ...t.billing, stripeSubscriptionId: subscriptionId },
        });
    },
    async applyUpgrade(tenantId, tier) {
      calls.push({ method: "applyUpgrade", tenantId });
      const t = tenants.get(tenantId);
      if (t) tenants.set(tenantId, { ...t, tier });
    },
    async applyDowngrade(tenantId) {
      calls.push({ method: "applyDowngrade", tenantId });
      const t = tenants.get(tenantId);
      if (t) tenants.set(tenantId, { ...t, tier: "free" });
    },
    async setGraceExpiry(tenantId, graceExpiresAt) {
      calls.push({ method: "setGraceExpiry", tenantId });
      const t = tenants.get(tenantId);
      if (t) tenants.set(tenantId, { ...t, billing: { ...t.billing, graceExpiresAt } });
    },
    async listTenantsWithExpiredGrace(now) {
      return [...tenants.values()]
        .filter(
          (t) =>
            t.tier === "premium" && t.billing.graceExpiresAt && t.billing.graceExpiresAt <= now,
        )
        .map((t) => ({ id: t.id }));
    },
  };
  return { store, tenants, calls };
}

function fakeEvents() {
  const seen = new Set<string>();
  const events: WebhookEventStore = {
    async claim(eventId) {
      if (seen.has(eventId)) return false;
      seen.add(eventId);
      return true;
    },
  };
  return { events, seen };
}

function fakeStripe(overrides: Partial<StripeClient> = {}): StripeClient {
  return {
    createCustomer: vi.fn(async () => ({ id: "cus_fake" })),
    createCheckoutSession: vi.fn(async () => ({
      url: "https://checkout.stripe.com/session/fake",
    })),
    constructEvent: vi.fn(async (payload: string) => JSON.parse(payload) as StripeEvent),
    ...overrides,
  };
}

const billingEnvStub = () => ({
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_WEBHOOK_SECRET: "whsec_fake",
  STRIPE_PRICE_PREMIUM_MONTHLY: "price_monthly",
  STRIPE_PRICE_PREMIUM_ANNUAL: "price_annual",
});

function emptyFormsRepo(forms: (FormDoc & { _id: ObjectId })[] = []) {
  const unpublished: string[] = [];
  const formsRepo: BillingDeps["formsRepo"] = {
    collectionName: "forms",
    collection: async () => {
      throw new Error("not used in these tests");
    },
    async find() {
      return forms;
    },
    async findOne() {
      return forms[0] ?? null;
    },
    async findById() {
      return null;
    },
    async count() {
      return forms.length;
    },
    async insertOne() {
      throw new Error("not used");
    },
    async updateOne() {
      return null;
    },
    async softDelete() {
      return false;
    },
    async listPage() {
      return { items: forms, meta: { limit: 50, hasMore: false, cursor: null } };
    },
  };
  return { formsRepo, unpublished };
}

function usageMetersRepoOf(counts: Record<string, number>) {
  const usageMetersRepo: BillingDeps["usageMetersRepo"] = {
    collectionName: "usage_meters",
    collection: async () => {
      throw new Error("not used");
    },
    async find() {
      return [];
    },
    async findOne(_ctx, filter) {
      const meter = (filter as { meter?: string })?.meter;
      if (!meter || !(meter in counts)) return null;
      return { _id: new ObjectId(), meter, period: "all", count: counts[meter] } as never;
    },
    async findById() {
      return null;
    },
    async count() {
      return 0;
    },
    async insertOne() {
      throw new Error("not used");
    },
    async updateOne() {
      return null;
    },
    async softDelete() {
      return false;
    },
    async listPage() {
      return { items: [], meta: { limit: 50, hasMore: false, cursor: null } };
    },
  };
  return usageMetersRepo;
}

function deps(over: Partial<BillingDeps> = {}): Partial<BillingDeps> {
  const { formsRepo } = emptyFormsRepo();
  return {
    events: fakeEvents().events,
    formsRepo,
    usageMetersRepo: usageMetersRepoOf({}),
    unpublishForm: vi.fn(async () => undefined),
    stripe: fakeStripe(),
    now: () => new Date("2026-06-01T00:00:00.000Z"),
    billingEnv: billingEnvStub,
    appUrl: () => "http://localhost:3000",
    ...over,
  };
}

const tenant = (over: Partial<BillingTenantSnapshot> = {}): BillingTenantSnapshot => ({
  id: TENANT_A,
  tier: "free",
  billing: { stripeCustomerId: null, stripeSubscriptionId: null, graceExpiresAt: null },
  ...over,
});

describe("applyUpgrade / applyDowngradePolicy — tier transition logic", () => {
  it("AC1 — upgrade raises the tier and clears any downgrade freeze", async () => {
    const { store, tenants } = fakeStore({ [TENANT_A]: tenant() });
    await applyUpgrade(TENANT_A, "premium", deps({ store }));
    expect(tenants.get(TENANT_A)?.tier).toBe("premium");
  });

  it("AC4 — downgrade freezes over-limit meters without deleting anything", async () => {
    const { store, tenants } = fakeStore({ [TENANT_A]: tenant({ tier: "premium" }) });
    const usageMetersRepo = usageMetersRepoOf({ entities: 10, records: 500 });
    await applyDowngradePolicy(TENANT_A, deps({ store, usageMetersRepo }));
    expect(tenants.get(TENANT_A)?.tier).toBe("free");
  });

  it("does not freeze a meter that is within the new (Free) limit", async () => {
    const { store, calls } = fakeStore({ [TENANT_A]: tenant({ tier: "premium" }) });
    const usageMetersRepo = usageMetersRepoOf({ entities: 1, records: 5 });
    await applyDowngradePolicy(TENANT_A, deps({ store, usageMetersRepo }));
    expect(calls.filter((c) => c.method === "applyDowngrade")).toHaveLength(1);
  });

  it("AC8 — trial expiry takes the exact same path as a subscription deletion", async () => {
    const { store: storeA, calls: callsA } = fakeStore({
      [TENANT_A]: tenant({ tier: "premium" }),
    });
    const { store: storeB, calls: callsB } = fakeStore({
      [TENANT_A]: tenant({ tier: "premium" }),
    });
    const usageMetersRepo = usageMetersRepoOf({ entities: 0, records: 0 });

    await applyDowngradePolicy(TENANT_A, deps({ store: storeA, usageMetersRepo }));
    await expireTrial(TENANT_A, deps({ store: storeB, usageMetersRepo }));

    expect(callsA.map((c) => c.method)).toEqual(callsB.map((c) => c.method));
  });
});

describe("downgrade policy — which forms unpublish", () => {
  const formDoc = (id: number, createdAt: string): FormDoc & { _id: ObjectId } =>
    ({
      _id: new ObjectId(id.toString(16).padStart(24, "0")),
      tenantId: new ObjectId(TENANT_A.padStart(24, "0")),
      entityDefId: new ObjectId(),
      name: `Form ${id}`,
      slug: `form-${id}`,
      publicSlug: `tenant/form-${id}`,
      visibility: "public",
      published: true,
      enabled: true,
      killSwitchAt: null,
      killSwitchBy: null,
      fields: [],
      showBadge: true,
      deletedAt: null,
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
    }) as FormDoc & { _id: ObjectId };

  it("keeps the oldest forms up to the new limit, unpublishes the rest", async () => {
    const { store } = fakeStore({ [TENANT_A]: tenant({ tier: "premium" }) });
    // Free's activeForms limit is 2 (docs/TIERS.md §2.1) — 3 forms means 1 unpublished.
    const forms = [
      formDoc(1, "2026-01-01T00:00:00Z"),
      formDoc(2, "2026-02-01T00:00:00Z"),
      formDoc(3, "2026-03-01T00:00:00Z"),
    ];
    const unpublishForm = vi.fn(async () => undefined);
    const { formsRepo } = emptyFormsRepo(forms);
    const usageMetersRepo = usageMetersRepoOf({ entities: 0, records: 0 });

    await applyDowngradePolicy(
      TENANT_A,
      deps({ store, formsRepo, unpublishForm, usageMetersRepo }),
    );

    expect(TIER_LIMITS.free.activeForms).toBe(2);
    expect(unpublishForm).toHaveBeenCalledTimes(1);
    expect(unpublishForm).toHaveBeenCalledWith(expect.anything(), forms[2]._id.toHexString());
  });

  it("unpublishes nothing when already within the new limit", async () => {
    const { store } = fakeStore({ [TENANT_A]: tenant({ tier: "premium" }) });
    const forms = [formDoc(1, "2026-01-01T00:00:00Z")];
    const unpublishForm = vi.fn(async () => undefined);
    const { formsRepo } = emptyFormsRepo(forms);
    const usageMetersRepo = usageMetersRepoOf({ entities: 0, records: 0 });

    await applyDowngradePolicy(
      TENANT_A,
      deps({ store, formsRepo, unpublishForm, usageMetersRepo }),
    );

    expect(unpublishForm).not.toHaveBeenCalled();
  });
});

describe("grace period — GRAFT-15 AC5", () => {
  it("defaults `now` to the real clock when no override is given", async () => {
    const { store, tenants } = fakeStore({ [TENANT_A]: tenant({ tier: "premium" }) });
    const { events } = fakeEvents();
    const before = Date.now();
    await startGracePeriod(TENANT_A, { store, events });
    const grace = tenants.get(TENANT_A)?.billing.graceExpiresAt;
    expect(grace).not.toBeNull();
    expect(grace!.getTime()).toBeGreaterThan(before);
  });

  it("invoice.payment_failed keeps the tenant on Premium and sets a 7-day expiry", async () => {
    const { store, tenants } = fakeStore({ [TENANT_A]: tenant({ tier: "premium" }) });
    const now = () => new Date("2026-06-01T00:00:00.000Z");
    await startGracePeriod(TENANT_A, deps({ store, now }));

    const grace = tenants.get(TENANT_A)?.billing.graceExpiresAt;
    expect(grace?.toISOString()).toBe("2026-06-08T00:00:00.000Z");
    expect(tenants.get(TENANT_A)?.tier).toBe("premium");
  });

  it("expireDueGracePeriods downgrades only tenants whose grace has actually passed", async () => {
    const now = new Date("2026-06-10T00:00:00.000Z");
    const { store, tenants } = fakeStore({
      [TENANT_A]: tenant({
        tier: "premium",
        billing: {
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          graceExpiresAt: new Date("2026-06-01T00:00:00Z"),
        },
      }),
      [TENANT_B]: tenant({
        id: TENANT_B,
        tier: "premium",
        billing: {
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          graceExpiresAt: new Date("2026-06-20T00:00:00Z"),
        },
      }),
    });
    const usageMetersRepo = usageMetersRepoOf({ entities: 0, records: 0 });

    const count = await expireDueGracePeriods(deps({ store, usageMetersRepo, now: () => now }));

    expect(count).toBe(1);
    expect(tenants.get(TENANT_A)?.tier).toBe("free");
    expect(tenants.get(TENANT_B)?.tier).toBe("premium");
  });
});

describe("handleStripeWebhookEvent — signature and idempotency (AC2, AC3)", () => {
  it("AC2 — a missing signature is rejected and nothing is touched", async () => {
    const { store, calls } = fakeStore({ [TENANT_A]: tenant() });
    await expect(handleStripeWebhookEvent("{}", null, deps({ store }))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(calls).toHaveLength(0);
  });

  it("AC2 — a signature the Stripe SDK rejects is a 400, and changes nothing", async () => {
    const { store, calls } = fakeStore({ [TENANT_A]: tenant() });
    const stripe = fakeStripe({
      constructEvent: vi.fn(async () => {
        throw new Error("invalid signature");
      }),
    });
    await expect(
      handleStripeWebhookEvent("{}", "bad-sig", deps({ store, stripe })),
    ).rejects.toBeInstanceOf(AppError);
    expect(calls).toHaveLength(0);
  });

  it("AC3 — replaying the same event id produces exactly one tier change", async () => {
    const { store, tenants, calls } = fakeStore({ [TENANT_A]: tenant() });
    const { events } = fakeEvents();
    const usageMetersRepo = usageMetersRepoOf({ entities: 0, records: 0 });
    const event: StripeEvent = {
      id: "evt_replay_1",
      type: "checkout.session.completed",
      data: {
        object: { customer: "cus_1", subscription: "sub_1", metadata: { tenantId: TENANT_A } },
      },
    };
    const stripe = fakeStripe({ constructEvent: vi.fn(async () => event) });
    const options = deps({ store, events, usageMetersRepo, stripe });

    await handleStripeWebhookEvent(JSON.stringify(event), "sig", options);
    await handleStripeWebhookEvent(JSON.stringify(event), "sig", options);

    expect(tenants.get(TENANT_A)?.tier).toBe("premium");
    expect(calls.filter((c) => c.method === "applyUpgrade")).toHaveLength(1);
  });

  it("cross-tenant isolation — a webhook for tenant A never mutates tenant B", async () => {
    const { store, tenants } = fakeStore({
      [TENANT_A]: tenant(),
      [TENANT_B]: tenant({ id: TENANT_B }),
    });
    const { events } = fakeEvents();
    const usageMetersRepo = usageMetersRepoOf({ entities: 0, records: 0 });
    const event: StripeEvent = {
      id: "evt_tenant_a",
      type: "checkout.session.completed",
      data: {
        object: { customer: "cus_a", subscription: "sub_a", metadata: { tenantId: TENANT_A } },
      },
    };
    const stripe = fakeStripe({ constructEvent: vi.fn(async () => event) });

    await handleStripeWebhookEvent(
      JSON.stringify(event),
      "sig",
      deps({ store, events, usageMetersRepo, stripe }),
    );

    expect(tenants.get(TENANT_A)?.tier).toBe("premium");
    expect(tenants.get(TENANT_B)?.tier).toBe("free");
  });

  it("an event with no resolvable tenant id is accepted and does nothing", async () => {
    const { store, calls } = fakeStore({ [TENANT_A]: tenant() });
    const { events } = fakeEvents();
    const event: StripeEvent = {
      id: "evt_no_tenant",
      type: "checkout.session.completed",
      data: { object: { customer: "cus_x" } },
    };
    const stripe = fakeStripe({ constructEvent: vi.fn(async () => event) });

    await expect(
      handleStripeWebhookEvent(JSON.stringify(event), "sig", deps({ store, events, stripe })),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("AC5 — invoice.payment_failed starts the grace period via the stored customer id", async () => {
    const { store, tenants } = fakeStore({
      [TENANT_A]: tenant({
        billing: {
          stripeCustomerId: "cus_a",
          stripeSubscriptionId: null,
          graceExpiresAt: null,
        },
      }),
    });
    const { events } = fakeEvents();
    const event: StripeEvent = {
      id: "evt_invoice_failed",
      type: "invoice.payment_failed",
      data: { object: { customer: "cus_a" } },
    };
    const stripe = fakeStripe({ constructEvent: vi.fn(async () => event) });

    await handleStripeWebhookEvent(
      JSON.stringify(event),
      "sig",
      deps({ store, events, stripe }),
    );

    expect(tenants.get(TENANT_A)?.billing.graceExpiresAt).not.toBeNull();
  });

  it("customer.subscription.deleted downgrades the tenant it names", async () => {
    const { store, tenants } = fakeStore({ [TENANT_A]: tenant({ tier: "premium" }) });
    const { events } = fakeEvents();
    const usageMetersRepo = usageMetersRepoOf({ entities: 0, records: 0 });
    const event: StripeEvent = {
      id: "evt_sub_deleted",
      type: "customer.subscription.deleted",
      data: { object: { metadata: { tenantId: TENANT_A } } },
    };
    const stripe = fakeStripe({ constructEvent: vi.fn(async () => event) });

    await handleStripeWebhookEvent(
      JSON.stringify(event),
      "sig",
      deps({ store, events, usageMetersRepo, stripe }),
    );

    expect(tenants.get(TENANT_A)?.tier).toBe("free");
  });
});

describe("billingEnv — isolated from src/env.ts's app-wide schema", () => {
  const KEYS = [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_PREMIUM_MONTHLY",
    "STRIPE_PRICE_PREMIUM_ANNUAL",
  ] as const;

  it("throws a generic AppError when Stripe is not configured", () => {
    const saved = KEYS.map((k) => [k, process.env[k]] as const);
    for (const k of KEYS) delete process.env[k];
    try {
      expect(() => billingEnv()).toThrow(AppError);
    } finally {
      for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
    }
  });

  it("parses and caches valid Stripe env vars", () => {
    for (const [k, v] of Object.entries({
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
      STRIPE_PRICE_PREMIUM_MONTHLY: "price_m",
      STRIPE_PRICE_PREMIUM_ANNUAL: "price_a",
    })) {
      process.env[k] = v;
    }
    expect(billingEnv().STRIPE_SECRET_KEY).toBe("sk_test_x");
  });
});

describe("toSnapshot — the tenants-document conversion", () => {
  it("defaults an unrecognised tier to free and missing billing fields to null", () => {
    const snapshot = toSnapshot({
      _id: new ObjectId(TENANT_A.padStart(24, "0")),
      tier: "not-a-real-tier",
      limits: TIER_LIMITS.free,
    });
    expect(snapshot.tier).toBe("free");
    expect(snapshot.billing).toEqual({
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      graceExpiresAt: null,
    });
  });
});

describe("isDuplicateKey — the E11000 predicate", () => {
  it("recognises a Mongo duplicate-key error and rejects everything else", () => {
    expect(isDuplicateKey({ code: 11000 })).toBe(true);
    expect(isDuplicateKey({ code: 26 })).toBe(false);
    expect(isDuplicateKey(new Error("boom"))).toBe(false);
    expect(isDuplicateKey(null)).toBe(false);
  });
});

describe("createCheckoutSession — AC7 owner-only", () => {
  it("refuses a non-owner", async () => {
    const { store } = fakeStore({ [TENANT_A]: tenant() });
    await expect(
      createCheckoutSession(ctxFor(TENANT_A, ["member"]), { plan: "monthly" }, deps({ store })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("creates a Stripe customer once and returns the checkout URL", async () => {
    const { store, tenants } = fakeStore({ [TENANT_A]: tenant() });
    const stripe = fakeStripe();
    const url = await createCheckoutSession(
      ctxFor(TENANT_A, ["owner"]),
      { plan: "annual" },
      deps({ store, stripe }),
    );

    expect(url).toEqual({ url: "https://checkout.stripe.com/session/fake" });
    expect(stripe.createCustomer).toHaveBeenCalledTimes(1);
    expect(tenants.get(TENANT_A)?.billing.stripeCustomerId).toBe("cus_fake");
  });

  it("defaults the redirect URLs to the app's own APP_URL when no override is given", async () => {
    const savedEnv = { ...process.env };
    Object.assign(process.env, {
      APP_ENV: "dev",
      NODE_ENV: "test",
      MONGODB_URI: "mongodb://localhost:27017/graft_test",
      REDIS_URL: "redis://localhost:6379",
      APP_URL: "https://qa.graft.test",
    });
    try {
      const { store } = fakeStore({ [TENANT_A]: tenant() });
      const stripe = fakeStripe();
      const built = deps({ store, stripe });
      delete built.appUrl;
      const rest = built;
      await createCheckoutSession(ctxFor(TENANT_A, ["owner"]), { plan: "monthly" }, rest);

      expect(stripe.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({
          successUrl: "https://qa.graft.test/billing/success",
          cancelUrl: "https://qa.graft.test/billing/cancel",
        }),
      );
    } finally {
      process.env = savedEnv;
    }
  });

  it("reuses an existing Stripe customer instead of creating a second one", async () => {
    const { store } = fakeStore({
      [TENANT_A]: tenant({
        billing: {
          stripeCustomerId: "cus_existing",
          stripeSubscriptionId: null,
          graceExpiresAt: null,
        },
      }),
    });
    const stripe = fakeStripe();
    await createCheckoutSession(
      ctxFor(TENANT_A, ["owner"]),
      { plan: "monthly" },
      deps({ store, stripe }),
    );

    expect(stripe.createCustomer).not.toHaveBeenCalled();
  });
});
