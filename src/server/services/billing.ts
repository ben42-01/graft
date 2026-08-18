/**
 * Stripe checkout and webhooks — upgrades, downgrades and grace periods
 * (GRAFT-15, docs/TIERS.md §3–§4, docs/GO-LIVE.md §4).
 *
 * The rule that shapes every write in this file: **nothing is ever deleted on
 * downgrade.** Over-limit public forms are unpublished (their definitions and
 * submissions survive), over-limit entities/records are frozen read-only via
 * the same `tenants.readOnly` mechanism GRAFT-05 already enforces
 * (src/server/services/entitlements.ts) — this module only ever decides
 * *which* meter keys go in that array, never touches a document.
 *
 * Three things matter enough to call out:
 *
 *   - **`tenants` is read and written directly, not through the ctx-injecting
 *     repository layer.** Same argument as entitlements.ts and
 *     accounts-store.ts: a webhook has no ctx (no authenticated caller) and
 *     `tenants` is a global collection keyed by `_id`, not tenant-scoped data.
 *     Every write here still filters by one exact `_id`, so a webhook for
 *     tenant A can never reach tenant B.
 *   - **Idempotency is a claim, not a check.** `event.id` is inserted as the
 *     Mongo `_id` of a dedup log; a duplicate delivery loses the unique-index
 *     race and is dropped before any tier logic runs (AC3) — there is no
 *     read-then-write window for two concurrent deliveries to both win.
 *   - **The tenant a webhook acts on is read from `metadata.tenantId`, set by
 *     us when the Checkout Session (and its subscription) were created — never
 *     looked up by matching arbitrary Stripe fields to guessed tenants.** The
 *     one exception is `invoice.payment_failed`, whose object carries no
 *     metadata; that path resolves the tenant via the Stripe customer id
 *     stored on `tenants.billing.stripeCustomerId` at checkout completion.
 */
import { ObjectId } from "mongodb";
import Stripe from "stripe";
import { z } from "zod";
import type { Ctx } from "@/server/context";
import { createContext } from "@/server/context";
import { getDb } from "@/server/db/mongo";
import { AppError } from "@/server/http/envelope";
import { parse } from "@/server/http/validate";
import { createLogger } from "@/server/log";
import { env } from "@/env";
import { TIER_LIMITS, TIERS, type Tier, type TierLimits } from "@/server/tiers";
import { unpublishForm as unpublishFormDefault, type FormDoc } from "./forms";
import { LIFETIME_PERIOD } from "./meters";
import { createRepository, type Repository } from "@/server/repositories/base";

/** A sentinel, not a user — see public-forms.ts's `PUBLIC_SUBMITTER_ID` for the
 * same reasoning. A webhook never authenticates anyone, so the ctx built here
 * exists only to reuse the tenant-scoped repository layer safely. */
const SYSTEM_ACTOR_ID = "000000000000000000000000";

const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

export const CHECKOUT_PLANS = ["monthly", "annual"] as const;
export type CheckoutPlan = (typeof CHECKOUT_PLANS)[number];

export const checkoutSchema = z.object({ plan: z.enum(CHECKOUT_PLANS) });
export type CheckoutInput = z.input<typeof checkoutSchema>;

/** Validated separately from src/env.ts's global schema on purpose: those
 * variables gate every route in the app, and a missing Stripe key must only
 * ever break billing, never the rest of the product. */
const billingEnvSchema = z.object({
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  STRIPE_PRICE_PREMIUM_MONTHLY: z.string().min(1),
  STRIPE_PRICE_PREMIUM_ANNUAL: z.string().min(1),
});
export type BillingEnv = z.infer<typeof billingEnvSchema>;

let cachedBillingEnv: BillingEnv | null = null;

export function billingEnv(): BillingEnv {
  if (cachedBillingEnv) return cachedBillingEnv;
  const parsed = billingEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    createLogger({ requestId: "billing.env" }).error("billing.env.invalid", {
      missing: parsed.error.issues.map((i) => i.path.join(".")),
    });
    throw new AppError("INTERNAL", "Billing is not configured");
  }
  cachedBillingEnv = parsed.data;
  return cachedBillingEnv;
}

function systemCtx(tenantId: string, tier: Tier): Ctx {
  return createContext({
    requestId: `billing-system-${tenantId}`,
    tenantId,
    userId: SYSTEM_ACTOR_ID,
    roles: ["owner"],
    tier,
  });
}

/** The minimal shape this module needs out of a Stripe event — never the SDK's
 * full type, so a test can build one by hand without depending on `stripe`. */
export type StripeEvent = {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
};

export type StripeClient = {
  createCustomer(input: { tenantId: string }): Promise<{ id: string }>;
  createCheckoutSession(input: {
    customerId: string;
    priceId: string;
    tenantId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string | null }>;
  /** Throws on a missing/invalid signature — never returns a "valid: false". */
  constructEvent(payload: string, signature: string, secret: string): Promise<StripeEvent>;
};

export type TenantBilling = {
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  graceExpiresAt: Date | null;
};

export type BillingTenantSnapshot = { id: string; tier: Tier; billing: TenantBilling };

/**
 * The tenant-document port. Every method takes (or resolves to) exactly one
 * tenant id — there is no "list of ids to update" method, on purpose, so
 * cross-tenant writes are impossible by the shape of the port, not by care.
 */
export type BillingStore = {
  findTenantById(tenantId: string): Promise<BillingTenantSnapshot | null>;
  findTenantByStripeCustomerId(customerId: string): Promise<BillingTenantSnapshot | null>;
  setStripeCustomerId(tenantId: string, customerId: string): Promise<void>;
  setSubscriptionId(tenantId: string, subscriptionId: string | null): Promise<void>;
  applyUpgrade(tenantId: string, tier: Tier, limits: TierLimits): Promise<void>;
  applyDowngrade(
    tenantId: string,
    limits: TierLimits,
    readOnly: readonly string[],
    now: Date,
  ): Promise<void>;
  setGraceExpiry(tenantId: string, graceExpiresAt: Date | null): Promise<void>;
  listTenantsWithExpiredGrace(now: Date): Promise<{ id: string }[]>;
};

/** Claims an event id exactly once (AC3). */
export type WebhookEventStore = {
  claim(eventId: string, type: string, now: Date): Promise<boolean>;
};

export type BillingDeps = {
  store: BillingStore;
  events: WebhookEventStore;
  formsRepo: Repository<FormDoc>;
  usageMetersRepo: Repository<{ meter: string; period: string; count: number }>;
  unpublishForm: (ctx: Ctx, formId: string) => Promise<unknown>;
  stripe: StripeClient;
  now: () => Date;
  billingEnv: () => BillingEnv;
  /** The app's own base URL, for the Checkout redirect targets — a seam so a
   * unit test never has to satisfy src/env.ts's full, app-wide schema. */
  appUrl: () => string;
};

type TenantBillingDoc = {
  _id: ObjectId;
  tier: string;
  limits: TierLimits;
  readOnly?: string[];
  downgradedAt?: Date | null;
  billing?: {
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    graceExpiresAt?: Date | null;
  };
};

export const toSnapshot = (doc: TenantBillingDoc): BillingTenantSnapshot => ({
  id: doc._id.toHexString(),
  tier: (TIERS.includes(doc.tier as Tier) ? doc.tier : "free") as Tier,
  billing: {
    stripeCustomerId: doc.billing?.stripeCustomerId ?? null,
    stripeSubscriptionId: doc.billing?.stripeSubscriptionId ?? null,
    graceExpiresAt: doc.billing?.graceExpiresAt ?? null,
  },
});

export function mongoBillingStore(): BillingStore {
  const tenants = async () => (await getDb()).collection<TenantBillingDoc>("tenants");

  return {
    async findTenantById(tenantId) {
      if (!ObjectId.isValid(tenantId)) return null;
      const col = await tenants();
      const doc = await col.findOne({ _id: new ObjectId(tenantId) });
      return doc ? toSnapshot(doc) : null;
    },

    async findTenantByStripeCustomerId(customerId) {
      const col = await tenants();
      const doc = await col.findOne({ "billing.stripeCustomerId": customerId });
      return doc ? toSnapshot(doc) : null;
    },

    async setStripeCustomerId(tenantId, customerId) {
      const col = await tenants();
      await col.updateOne(
        { _id: new ObjectId(tenantId) },
        { $set: { "billing.stripeCustomerId": customerId, updatedAt: new Date() } },
      );
    },

    async setSubscriptionId(tenantId, subscriptionId) {
      const col = await tenants();
      await col.updateOne(
        { _id: new ObjectId(tenantId) },
        { $set: { "billing.stripeSubscriptionId": subscriptionId, updatedAt: new Date() } },
      );
    },

    /** AC1, AC6 — the tier and its limits take effect immediately, and any
     * downgrade freeze lifts: every retained resource is reachable again. */
    async applyUpgrade(tenantId, tier, limits) {
      const col = await tenants();
      await col.updateOne(
        { _id: new ObjectId(tenantId) },
        {
          $set: {
            tier,
            limits,
            readOnly: [],
            downgradedAt: null,
            "billing.graceExpiresAt": null,
            updatedAt: new Date(),
          },
        },
      );
    },

    /** AC4 — never a delete, only a tier/limits/readOnly rewrite. */
    async applyDowngrade(tenantId, limits, readOnly, now) {
      const col = await tenants();
      await col.updateOne(
        { _id: new ObjectId(tenantId) },
        {
          $set: {
            tier: "free",
            limits,
            readOnly: [...readOnly],
            downgradedAt: now,
            "billing.graceExpiresAt": null,
            updatedAt: now,
          },
        },
      );
    },

    async setGraceExpiry(tenantId, graceExpiresAt) {
      const col = await tenants();
      await col.updateOne(
        { _id: new ObjectId(tenantId) },
        { $set: { "billing.graceExpiresAt": graceExpiresAt, updatedAt: new Date() } },
      );
    },

    async listTenantsWithExpiredGrace(now) {
      const col = await tenants();
      const docs = await col
        .find({ tier: "premium", "billing.graceExpiresAt": { $ne: null, $lte: now } })
        .toArray();
      return docs.map((doc) => ({ id: doc._id.toHexString() }));
    },
  };
}

export const isDuplicateKey = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code: unknown }).code === 11000;

/** `event.id` doubles as the Mongo `_id` — the unique index every collection
 * already has for free is the entire dedup mechanism (AC3). */
export function mongoWebhookEventStore(): WebhookEventStore {
  return {
    async claim(eventId, type, now) {
      const db = await getDb();
      try {
        await db
          .collection("billing_webhook_events")
          .insertOne({ _id: eventId, type, createdAt: now } as never);
        return true;
      } catch (error) {
        if (isDuplicateKey(error)) return false;
        throw error;
      }
    },
  };
}

let cachedStripeSdk: Stripe | null = null;

function stripeSdk(secretKey: string): Stripe {
  cachedStripeSdk ??= new Stripe(secretKey);
  return cachedStripeSdk;
}

/** The real Stripe client. `getEnv` is a parameter (not a closed-over call) so
 * a test never has to set real Stripe env vars to construct this module. */
export function realStripeClient(getEnv: () => BillingEnv = billingEnv): StripeClient {
  return {
    async createCustomer({ tenantId }) {
      const sdk = stripeSdk(getEnv().STRIPE_SECRET_KEY);
      const customer = await sdk.customers.create({ metadata: { tenantId } });
      return { id: customer.id };
    },

    async createCheckoutSession({ customerId, priceId, tenantId, successUrl, cancelUrl }) {
      const sdk = stripeSdk(getEnv().STRIPE_SECRET_KEY);
      const session = await sdk.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: { tenantId },
        subscription_data: { metadata: { tenantId } },
      });
      return { url: session.url };
    },

    // Synchronous and network-free under the hood — verifying a signature is
    // pure HMAC over the raw body (see module docs) — but the port stays
    // async so a caller never has to know that.
    async constructEvent(payload, signature, secret) {
      const sdk = stripeSdk(getEnv().STRIPE_SECRET_KEY);
      const event = sdk.webhooks.constructEvent(payload, signature, secret);
      return event as unknown as StripeEvent;
    },
  };
}

const defaultFormsRepo = createRepository<FormDoc>("forms");
const defaultUsageMetersRepo = createRepository<{
  meter: string;
  period: string;
  count: number;
}>("usage_meters");

function resolveDeps(overrides: Partial<BillingDeps> = {}): BillingDeps {
  return {
    store: overrides.store ?? mongoBillingStore(),
    events: overrides.events ?? mongoWebhookEventStore(),
    formsRepo: overrides.formsRepo ?? defaultFormsRepo,
    usageMetersRepo: overrides.usageMetersRepo ?? defaultUsageMetersRepo,
    unpublishForm: overrides.unpublishForm ?? unpublishFormDefault,
    stripe: overrides.stripe ?? realStripeClient(),
    now: overrides.now ?? (() => new Date()),
    billingEnv: overrides.billingEnv ?? billingEnv,
    appUrl: overrides.appUrl ?? (() => env().APP_URL),
  };
}

async function meterUsed(
  deps: BillingDeps,
  ctx: Ctx,
  meter: "entities" | "records",
): Promise<number> {
  const doc = await deps.usageMetersRepo.findOne(ctx, { meter, period: LIFETIME_PERIOD });
  return doc?.count ?? 0;
}

/**
 * AC4 — the downgrade policy. Sets the new (Free) tier and limits, freezes
 * whichever meters are already over the new limit (never deletes anything),
 * and unpublishes public forms beyond the new `activeForms` cap, oldest kept.
 * Reused verbatim by `customer.subscription.deleted`, grace-period expiry
 * (AC5) and trial expiry (AC8) — "the same path" all three ACs require.
 */
export async function applyDowngradePolicy(
  tenantId: string,
  overrides: Partial<BillingDeps> = {},
): Promise<void> {
  const deps = resolveDeps(overrides);
  const now = deps.now();
  const newLimits = TIER_LIMITS.free;
  const ctx = systemCtx(tenantId, "free");

  const readOnly: string[] = [];
  const usedEntities = await meterUsed(deps, ctx, "entities");
  if (newLimits.entities !== null && usedEntities > newLimits.entities)
    readOnly.push("entities");
  const usedRecords = await meterUsed(deps, ctx, "records");
  if (newLimits.records !== null && usedRecords > newLimits.records) readOnly.push("records");

  if (newLimits.activeForms !== null) {
    const publicForms = await deps.formsRepo.find(
      ctx,
      { visibility: "public", published: true },
      { sort: { createdAt: 1 } },
    );
    const overflow = publicForms.slice(newLimits.activeForms);
    for (const form of overflow) {
      await deps.unpublishForm(ctx, form._id.toHexString());
    }
  }

  await deps.store.applyDowngrade(tenantId, newLimits, readOnly, now);
}

/** AC1, AC6, AC8's shared re-subscribe path — raises the tenant and clears
 * any downgrade freeze immediately, no re-login required (entitlements are
 * always read live from `tenants`, never from the token's tier claim). */
export async function applyUpgrade(
  tenantId: string,
  tier: Tier,
  overrides: Partial<BillingDeps> = {},
): Promise<void> {
  const deps = resolveDeps(overrides);
  await deps.store.applyUpgrade(tenantId, tier, TIER_LIMITS[tier]);
}

/** AC5 — Premium is kept through the grace window; only its expiry (see
 * `expireDueGracePeriods`) downgrades. */
export async function startGracePeriod(
  tenantId: string,
  overrides: Partial<BillingDeps> = {},
): Promise<void> {
  const deps = resolveDeps(overrides);
  const graceExpiresAt = new Date(deps.now().getTime() + GRACE_PERIOD_MS);
  await deps.store.setGraceExpiry(tenantId, graceExpiresAt);
}

/**
 * AC5's expiry half. Not wired to a scheduler by this issue (docs/GO-LIVE.md
 * §4 marks the grace-period job 🟡, separate from the launch gate) — this is
 * the function a future cron/job issue calls, and what its unit test proves
 * transitions correctly today.
 */
export async function expireDueGracePeriods(
  overrides: Partial<BillingDeps> = {},
): Promise<number> {
  const deps = resolveDeps(overrides);
  const due = await deps.store.listTenantsWithExpiredGrace(deps.now());
  for (const tenant of due) {
    await applyDowngradePolicy(tenant.id, overrides);
  }
  return due.length;
}

/**
 * AC8 — trial expiry "downgrades gracefully by the same path" as
 * `customer.subscription.deleted`: this is that path, named for its caller.
 * Issuing the 14-day trial itself is a signup-flow decision this issue does
 * not touch (see PR "Outside guidance") — this is what a future trial-expiry
 * caller (scheduler, signup-flow issue) invokes once a trial's `trialEndsAt`
 * has passed.
 */
export async function expireTrial(
  tenantId: string,
  overrides: Partial<BillingDeps> = {},
): Promise<void> {
  await applyDowngradePolicy(tenantId, overrides);
}

/** `metadata.tenantId`, set by us on every Checkout Session and the
 * subscription it creates (see `realStripeClient`) — never inferred. */
function readTenantId(object: Record<string, unknown>): string | null {
  const metadata = object.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const tenantId = (metadata as Record<string, unknown>).tenantId;
  return typeof tenantId === "string" && ObjectId.isValid(tenantId) ? tenantId : null;
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/**
 * AC2, AC3, AC4, AC5, AC8. Verifies the signature over the exact raw body
 * (AC2), claims the event id before doing anything else (AC3), then
 * dispatches by type. Unrecognised types and events with no resolvable tenant
 * are silently accepted — Stripe's dashboard treats a 4xx/5xx as "retry me",
 * and an event this module does not act on is not a delivery failure.
 */
export async function handleStripeWebhookEvent(
  payload: string,
  signature: string | null,
  overrides: Partial<BillingDeps> = {},
): Promise<void> {
  const deps = resolveDeps(overrides);
  const webhookEnv = deps.billingEnv();

  if (!signature) {
    throw new AppError("VALIDATION_FAILED", "Missing Stripe signature", { source: "body" });
  }

  let event: StripeEvent;
  try {
    event = await deps.stripe.constructEvent(
      payload,
      signature,
      webhookEnv.STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    throw new AppError("VALIDATION_FAILED", "Invalid Stripe signature", { source: "body" });
  }

  const isNew = await deps.events.claim(event.id, event.type, deps.now());
  if (!isNew) return;

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const tenantId = readTenantId(session);
      if (!tenantId) break;
      const customerId = asString(session.customer);
      const subscriptionId = asString(session.subscription);
      if (customerId) await deps.store.setStripeCustomerId(tenantId, customerId);
      if (subscriptionId) await deps.store.setSubscriptionId(tenantId, subscriptionId);
      await applyUpgrade(tenantId, "premium", overrides);
      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object;
      const tenantId = readTenantId(subscription);
      if (!tenantId) break;
      const status = asString(subscription.status);
      if (status === "active" || status === "trialing") {
        await applyUpgrade(tenantId, "premium", overrides);
      }
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      const tenantId = readTenantId(subscription);
      if (!tenantId) break;
      await applyDowngradePolicy(tenantId, overrides);
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object;
      const customerId = asString(invoice.customer);
      if (!customerId) break;
      const tenant = await deps.store.findTenantByStripeCustomerId(customerId);
      if (!tenant) break;
      await startGracePeriod(tenant.id, overrides);
      break;
    }

    default:
      break;
  }
}

/** AC7 — owner-only; the checkout URL itself is the only thing returned. */
export async function createCheckoutSession(
  ctx: Ctx,
  input: unknown,
  overrides: Partial<BillingDeps> = {},
): Promise<{ url: string }> {
  if (!ctx.roles.includes("owner")) {
    throw new AppError("FORBIDDEN", "Only the workspace owner can manage billing");
  }
  const deps = resolveDeps(overrides);
  const parsed = parse(checkoutSchema, input, "body");
  const checkoutEnv = deps.billingEnv();
  const priceId =
    parsed.plan === "monthly"
      ? checkoutEnv.STRIPE_PRICE_PREMIUM_MONTHLY
      : checkoutEnv.STRIPE_PRICE_PREMIUM_ANNUAL;

  const tenant = await deps.store.findTenantById(ctx.tenantId);
  if (!tenant) throw new AppError("NOT_FOUND", "Workspace not found");

  let customerId = tenant.billing.stripeCustomerId;
  if (!customerId) {
    const customer = await deps.stripe.createCustomer({ tenantId: ctx.tenantId });
    customerId = customer.id;
    await deps.store.setStripeCustomerId(ctx.tenantId, customerId);
  }

  const session = await deps.stripe.createCheckoutSession({
    customerId,
    priceId,
    tenantId: ctx.tenantId,
    successUrl: `${deps.appUrl()}/billing/success`,
    cancelUrl: `${deps.appUrl()}/billing/cancel`,
  });
  if (!session.url) throw new AppError("INTERNAL", "Could not start checkout");
  return { url: session.url };
}
