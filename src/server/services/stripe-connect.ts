/**
 * Stripe Connect — how a tenant takes card payments through Stripe Checkout on
 * their own Stripe account, with Graft opening the session.
 *
 * Link mode (src/lib/payment-links.ts) sends a visitor to a URL the tenant
 * pasted and can verify nothing. Checkout mode is the other half: the tenant
 * connects their Stripe account once, Graft creates a Checkout Session *on that
 * account* for the amount the order says is due, and a Connect webhook records
 * the payment on the order when Stripe says it was paid. The operator no
 * longer confirms payment by hand.
 *
 * Five things matter enough to call out:
 *
 *   - **No tenant secret is stored.** The only credential is the platform's own
 *     `STRIPE_SECRET_KEY`; a tenant is represented by its connected account id
 *     (`acct_…`), which is an identifier, not a key. Direct charges land in the
 *     tenant's balance — Graft never holds the money.
 *   - **The amount comes from the order, never the request.** The visitor sends
 *     no price. `createFormCheckout` reads the order the booking bridge just
 *     raised and charges what is due on it: the deposit when there is one, the
 *     total otherwise, less anything already paid.
 *   - **A webhook's tenant is proved by the account, not by metadata.** Metadata
 *     is written by us, but the event arrives from *a* connected account, and
 *     any connected account can create a Checkout Session with whatever
 *     metadata it likes. So a `checkout.session.completed` is only applied when
 *     `event.account` is the account stored on the tenant its metadata names.
 *     Without that check one tenant could mark another tenant's orders paid.
 *   - **Checkout is created after the submission commits, never inside it.** A
 *     Mongo transaction retries on transient errors; a Stripe call inside one
 *     would open a second session on retry. If Stripe fails, the submission and
 *     its order stand and the order simply waits in *Awaiting payment* — the
 *     same place link mode leaves every order.
 *   - **Its own env, its own failure.** Like billing.ts, the Connect variables
 *     are validated here and not in src/env.ts, so an unconfigured Connect
 *     breaks Checkout and nothing else.
 */
import { ObjectId } from "mongodb";
import Stripe from "stripe";
import { z } from "zod";
import { createContext, type Ctx } from "@/server/context";
import { getDb } from "@/server/db/mongo";
import { AppError } from "@/server/http/envelope";
import { parse } from "@/server/http/validate";
import { createLogger } from "@/server/log";
import { env } from "@/env";
import { TIERS, type Tier } from "@/server/tiers";
import {
  DEFAULT_CONNECT_COUNTRY,
  isStripeConnectCountry,
} from "@/lib/stripe-connect-countries";
import { recordPayment as recordPaymentDefault, type OrderDoc } from "./orders";
import { isDuplicateKey } from "./billing";

/** Stored on the tenant document. Absent until the tenant starts onboarding. */
export type StripeConnectDoc = {
  accountId: string;
  /** Stripe's own answer to "can this account take a card payment yet". */
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
  updatedAt: Date;
};

export type ConnectStatus = {
  connected: boolean;
  /** True once Stripe says the account can take payments — Checkout needs it. */
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
};

const connectEnvSchema = z.object({
  STRIPE_SECRET_KEY: z.string().min(1),
  /** The signing secret of the *Connect* endpoint ("Events on connected
   * accounts"), which is a different endpoint and secret from billing's. */
  STRIPE_CONNECT_WEBHOOK_SECRET: z.string().min(1),
});
export type ConnectEnv = z.infer<typeof connectEnvSchema>;

let cachedConnectEnv: ConnectEnv | null = null;

export function connectEnv(): ConnectEnv {
  if (cachedConnectEnv) return cachedConnectEnv;
  const parsed = connectEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    createLogger({ requestId: "connect.env" }).error("connect.env.invalid", {
      missing: parsed.error.issues.map((i) => i.path.join(".")),
    });
    throw new AppError("INTERNAL", "Card payments are not configured");
  }
  cachedConnectEnv = parsed.data;
  return cachedConnectEnv;
}

/** The minimal event shape this module reads — never the SDK's full type. */
export type ConnectEvent = {
  id: string;
  type: string;
  /** The connected account the event happened on; absent for platform events. */
  account?: string;
  data: { object: Record<string, unknown> };
};

/** One line on a Checkout Session. Its name is an item name or the form's
 * name — never anything the customer typed. */
export type CheckoutLine = { name: string; unitAmountMinor: number; quantity: number };

/** Stripe refuses a Checkout Session with more line items than this. */
export const STRIPE_MAX_LINE_ITEMS = 100;

export type ConnectStripeClient = {
  /** `country` is ISO 3166-1 alpha-2 and permanent on the account. */
  createAccount(input: { tenantId: string; country: string }): Promise<{ id: string }>;
  createAccountLink(input: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<{ url: string }>;
  retrieveAccount(
    accountId: string,
  ): Promise<{ chargesEnabled: boolean; detailsSubmitted: boolean }>;
  createCheckoutSession(input: {
    accountId: string;
    currency: string;
    /** Never empty; always sums to the amount due on the order. */
    lineItems: CheckoutLine[];
    metadata: Record<string, string>;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<{ url: string | null }>;
  /** Throws on a missing/invalid signature. */
  constructEvent(payload: string, signature: string, secret: string): Promise<ConnectEvent>;
};

export type ConnectStore = {
  find(tenantId: string): Promise<{ tier: Tier; connect: StripeConnectDoc | null } | null>;
  set(tenantId: string, connect: StripeConnectDoc | null): Promise<void>;
  findTenantIdByAccount(accountId: string): Promise<string | null>;
  findOrder(tenantId: string, orderId: string): Promise<(OrderDoc & { _id: ObjectId }) | null>;
};

/** Dedup for Connect deliveries. Unlike billing's, a claim can be released:
 * a delivery whose processing failed must stay retryable, or Stripe's retry
 * is dropped as a duplicate and the payment is never recorded. */
export type ConnectEventStore = {
  claim(eventId: string, type: string, now: Date): Promise<boolean>;
  release(eventId: string): Promise<void>;
};

export type ConnectDeps = {
  stripe: ConnectStripeClient;
  store: ConnectStore;
  events: ConnectEventStore;
  recordPayment: (ctx: Ctx, orderId: string, input: unknown) => Promise<unknown>;
  connectEnv: () => ConnectEnv;
  appUrl: () => string;
  now: () => Date;
};

type TenantConnectFields = { _id: ObjectId; tier?: string; stripeConnect?: StripeConnectDoc };

export function mongoConnectStore(): ConnectStore {
  const tenants = async () => (await getDb()).collection<TenantConnectFields>("tenants");
  return {
    async find(tenantId) {
      if (!ObjectId.isValid(tenantId)) return null;
      const doc = await (
        await tenants()
      ).findOne({ _id: new ObjectId(tenantId) }, { projection: { tier: 1, stripeConnect: 1 } });
      if (!doc) return null;
      return {
        tier: (TIERS.includes(doc.tier as Tier) ? doc.tier : "free") as Tier,
        connect: doc.stripeConnect ?? null,
      };
    },
    async set(tenantId, connect) {
      await (
        await tenants()
      ).updateOne(
        { _id: new ObjectId(tenantId) },
        connect ? { $set: { stripeConnect: connect } } : { $unset: { stripeConnect: "" } },
      );
    },
    async findTenantIdByAccount(accountId) {
      const doc = await (
        await tenants()
      ).findOne({ "stripeConnect.accountId": accountId }, { projection: { _id: 1 } });
      return doc ? doc._id.toHexString() : null;
    },
    async findOrder(tenantId, orderId) {
      if (!ObjectId.isValid(orderId)) return null;
      return (await getDb()).collection<OrderDoc>("orders").findOne({
        _id: new ObjectId(orderId),
        tenantId: new ObjectId(tenantId),
        deletedAt: null,
      });
    },
  };
}

export function mongoConnectEventStore(): ConnectEventStore {
  const col = async () => (await getDb()).collection("connect_webhook_events");
  return {
    async claim(eventId, type, now) {
      try {
        await (await col()).insertOne({ _id: eventId, type, createdAt: now } as never);
        return true;
      } catch (error) {
        if (isDuplicateKey(error)) return false;
        throw error;
      }
    },
    async release(eventId) {
      await (await col()).deleteOne({ _id: eventId } as never);
    },
  };
}

/** The slice of a v2 account `accountReadiness` reads. */
export type V2AccountReadiness = {
  configuration?: {
    merchant?: { capabilities?: { card_payments?: { status: string } } } | null;
  } | null;
  requirements?: {
    entries?: Array<{ awaiting_action_from: string; minimum_deadline: { status: string } }>;
  } | null;
};

/**
 * v2 has no `charges_enabled` / `details_submitted`. Their equivalents: the
 * merchant's card_payments capability is `active`, and nothing due now (or
 * overdue) is waiting on the account holder — what remains is Stripe's to
 * verify or due only eventually.
 */
export function accountReadiness(account: V2AccountReadiness): {
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
} {
  const cardPayments = account.configuration?.merchant?.capabilities?.card_payments;
  const owedByHolder = (account.requirements?.entries ?? []).some(
    (entry) =>
      entry.awaiting_action_from === "user" &&
      (entry.minimum_deadline.status === "currently_due" ||
        entry.minimum_deadline.status === "past_due"),
  );
  return { chargesEnabled: cardPayments?.status === "active", detailsSubmitted: !owedByHolder };
}

let cachedSdk: Stripe | null = null;
const sdk = (secretKey: string): Stripe => (cachedSdk ??= new Stripe(secretKey));

export function realConnectStripeClient(
  getEnv: () => ConnectEnv = connectEnv,
): ConnectStripeClient {
  return {
    async createAccount({ tenantId, country }) {
      // Accounts v2 (Stripe refuses v1 creation for new Connect platforms).
      // A full dashboard with Stripe collecting fees and carrying losses is
      // what v1 called a Standard account — and v1 reads it back as one: the
      // tenant owns it and carries its own fees, refunds and disputes. The
      // merchant configuration cannot be added without a country.
      const account = await sdk(getEnv().STRIPE_SECRET_KEY).v2.core.accounts.create({
        dashboard: "full",
        identity: { country: country.toLowerCase() },
        defaults: {
          responsibilities: { fees_collector: "stripe", losses_collector: "stripe" },
        },
        configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
        metadata: { tenantId },
      });
      return { id: account.id };
    },
    async createAccountLink({ accountId, refreshUrl, returnUrl }) {
      const link = await sdk(getEnv().STRIPE_SECRET_KEY).v2.core.accountLinks.create({
        account: accountId,
        use_case: {
          type: "account_onboarding",
          account_onboarding: { refresh_url: refreshUrl, return_url: returnUrl },
        },
      });
      return { url: link.url };
    },
    async retrieveAccount(accountId) {
      const account = await sdk(getEnv().STRIPE_SECRET_KEY).v2.core.accounts.retrieve(
        accountId,
        { include: ["configuration.merchant", "requirements"] },
      );
      return accountReadiness(account);
    },
    async createCheckoutSession(input) {
      const session = await sdk(getEnv().STRIPE_SECRET_KEY).checkout.sessions.create(
        {
          mode: "payment",
          line_items: input.lineItems.map((line) => ({
            quantity: line.quantity,
            price_data: {
              currency: input.currency.toLowerCase(),
              unit_amount: line.unitAmountMinor,
              product_data: { name: line.name },
            },
          })),
          client_reference_id: input.metadata.graftOrderId,
          metadata: input.metadata,
          payment_intent_data: { metadata: input.metadata },
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
        },
        { stripeAccount: input.accountId, idempotencyKey: input.idempotencyKey },
      );
      return { url: session.url };
    },
    async constructEvent(payload, signature, secret) {
      const event = sdk(getEnv().STRIPE_SECRET_KEY).webhooks.constructEvent(
        payload,
        signature,
        secret,
      );
      return event as unknown as ConnectEvent;
    },
  };
}

function resolveDeps(overrides: Partial<ConnectDeps> = {}): ConnectDeps {
  return {
    stripe: overrides.stripe ?? realConnectStripeClient(),
    store: overrides.store ?? mongoConnectStore(),
    events: overrides.events ?? mongoConnectEventStore(),
    recordPayment:
      overrides.recordPayment ??
      ((ctx, orderId, input) => recordPaymentDefault(ctx, orderId, input)),
    connectEnv: overrides.connectEnv ?? connectEnv,
    appUrl: overrides.appUrl ?? (() => env().APP_URL),
    now: overrides.now ?? (() => new Date()),
  };
}

const toStatus = (connect: StripeConnectDoc | null): ConnectStatus => ({
  connected: connect !== null,
  chargesEnabled: connect?.chargesEnabled ?? false,
  detailsSubmitted: connect?.detailsSubmitted ?? false,
});

/** Connecting decides where customers' money goes — not a member's call. */
function assertCanManage(ctx: Ctx) {
  if (!ctx.roles.includes("owner") && !ctx.roles.includes("admin")) {
    throw new AppError("FORBIDDEN", "Only an owner or admin can manage card payments");
  }
}

/**
 * The tenant's connection, refreshed from Stripe while onboarding is
 * unfinished — a tenant who just came back from Stripe should see the result
 * without waiting for `account.updated` to arrive.
 */
export async function getConnectStatus(
  ctx: Ctx,
  overrides: Partial<ConnectDeps> = {},
): Promise<ConnectStatus> {
  const deps = resolveDeps(overrides);
  const tenant = await deps.store.find(ctx.tenantId);
  if (!tenant) throw new AppError("NOT_FOUND", "Workspace not found");
  const connect = tenant.connect;
  if (!connect || connect.chargesEnabled) return toStatus(connect);

  const live = await deps.stripe.retrieveAccount(connect.accountId);
  const next: StripeConnectDoc = { ...connect, ...live, updatedAt: deps.now() };
  await deps.store.set(ctx.tenantId, next);
  return toStatus(next);
}

/** Where onboarding sends the tenant back. Only in-app form pages or the
 * forms list — never a caller-supplied URL, which would be an open redirect. */
export const onboardingSchema = z.object({
  returnTo: z
    .string()
    .regex(/^\/forms(\/[0-9a-f]{24})?$/i, "Not a place to return to")
    .default("/forms"),
  /** Only read when the account is created — it is permanent after that. */
  country: z
    .string()
    .refine(isStripeConnectCountry, "Stripe can't take card payments in that country")
    .default(DEFAULT_CONNECT_COUNTRY),
});

/** Creates the connected account on first use, then an onboarding link. */
export async function startConnectOnboarding(
  ctx: Ctx,
  input: unknown,
  overrides: Partial<ConnectDeps> = {},
): Promise<{ url: string }> {
  assertCanManage(ctx);
  const deps = resolveDeps(overrides);
  const { returnTo, country } = parse(onboardingSchema, input ?? {}, "body");
  const tenant = await deps.store.find(ctx.tenantId);
  if (!tenant) throw new AppError("NOT_FOUND", "Workspace not found");

  let accountId = tenant.connect?.accountId ?? null;
  if (!accountId) {
    accountId = (await deps.stripe.createAccount({ tenantId: ctx.tenantId, country })).id;
    await deps.store.set(ctx.tenantId, {
      accountId,
      chargesEnabled: false,
      detailsSubmitted: false,
      updatedAt: deps.now(),
    });
  }

  const back = `${deps.appUrl()}${returnTo}?stripe=return`;
  return deps.stripe.createAccountLink({ accountId, refreshUrl: back, returnUrl: back });
}

/**
 * Forgets the connected account. The Stripe account itself is the tenant's
 * and stays theirs; Checkout forms simply stop offering card payment.
 */
export async function disconnectStripe(
  ctx: Ctx,
  overrides: Partial<ConnectDeps> = {},
): Promise<ConnectStatus> {
  assertCanManage(ctx);
  const deps = resolveDeps(overrides);
  await deps.store.set(ctx.tenantId, null);
  return toStatus(null);
}

/** What is still owed before the order can be confirmed. Mirrors the
 * threshold `recordPayment` confirms against. */
export function amountDueMinor(
  order: Pick<OrderDoc, "depositMinor" | "totalMinor" | "amountPaidMinor">,
): number {
  const threshold = order.depositMinor > 0 ? order.depositMinor : order.totalMinor;
  return Math.max(0, threshold - order.amountPaidMinor);
}

const clipName = (name: string) => name.slice(0, 250);

/**
 * What the Checkout Session shows the customer, line by line.
 *
 * Itemised only when the whole order is being charged at once — then each
 * order line becomes a Stripe line and the receipt reads like the cart. A
 * deposit or a balance after a partial payment is one line for the amount due,
 * because the order's lines would not add up to it. Whatever the shape, the
 * lines **always** sum to `amountDueMinor(order)`: any itemisation that would
 * not (a discount, which Stripe cannot take as a negative line, or data that
 * does not add up) collapses to a single "Order — <form>" line instead.
 */
export function checkoutLines(
  order: Pick<OrderDoc, "lineItems" | "depositMinor" | "totalMinor" | "amountPaidMinor">,
  formName: string,
): CheckoutLine[] {
  const due = amountDueMinor(order);
  const single = (name: string): CheckoutLine[] => [
    { name: clipName(name), unitAmountMinor: due, quantity: 1 },
  ];

  if (order.amountPaidMinor > 0) return single(`Balance — ${formName}`);
  if (order.depositMinor > 0 && order.depositMinor < order.totalMinor) {
    return single(`Deposit — ${formName}`);
  }
  if (order.lineItems.length === 0) return single(formName);
  if (order.lineItems.length > STRIPE_MAX_LINE_ITEMS) return single(`Order — ${formName}`);

  const lines = order.lineItems.map((item): CheckoutLine => {
    const name = clipName(item.description || formName);
    // Duration-priced lines can carry an amount that is not unit × quantity;
    // Stripe multiplies, so such a line goes as one of its whole amount.
    return item.unitAmountMinor * item.quantity === item.amountMinor
      ? { name, unitAmountMinor: item.unitAmountMinor, quantity: item.quantity }
      : { name, unitAmountMinor: item.amountMinor, quantity: 1 };
  });
  const sum = lines.reduce((total, line) => total + line.unitAmountMinor * line.quantity, 0);
  if (sum !== due || lines.some((line) => line.unitAmountMinor < 0)) {
    return single(`Order — ${formName}`);
  }
  return lines;
}

/**
 * Opens a Checkout Session for a just-submitted order. `null` whenever card
 * payment cannot honestly be offered — no connected account, onboarding not
 * finished, nothing due, or Stripe refusing — and the caller then answers as
 * a form without payment would. Never throws: the submission has already been
 * accepted, and a payment problem must not turn that into an error.
 */
export async function createFormCheckout(
  input: {
    tenantId: string;
    orderId: string;
    submissionId: string;
    formName: string;
    /** The public form's own path, e.g. `/f/harbour/book-a-boat`. */
    formPath: string;
    requestId: string;
  },
  overrides: Partial<ConnectDeps> = {},
): Promise<{ url: string } | null> {
  const deps = resolveDeps(overrides);
  const log = createLogger({ requestId: input.requestId });
  try {
    const tenant = await deps.store.find(input.tenantId);
    const connect = tenant?.connect;
    if (!connect?.chargesEnabled) return null;

    const order = await deps.store.findOrder(input.tenantId, input.orderId);
    if (!order) return null;
    if (amountDueMinor(order) <= 0) return null;

    const base = `${deps.appUrl()}${input.formPath}`;
    const session = await deps.stripe.createCheckoutSession({
      accountId: connect.accountId,
      currency: order.currency,
      lineItems: checkoutLines(order, input.formName),
      metadata: {
        graftTenantId: input.tenantId,
        graftOrderId: input.orderId,
        graftSubmissionId: input.submissionId,
      },
      successUrl: `${base}/paid`,
      cancelUrl: base,
      // One session per order, whatever retries the visitor's browser makes.
      idempotencyKey: `graft-form-checkout-${input.orderId}`,
    });
    return session.url ? { url: session.url } : null;
  } catch (error) {
    log.error("connect.checkout.failed", {
      orderId: input.orderId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function systemCtx(tenantId: string, tier: Tier, requestId: string): Ctx {
  return createContext({
    requestId,
    tenantId,
    // A sentinel, not a user — see billing.ts's SYSTEM_ACTOR_ID.
    userId: "000000000000000000000000",
    roles: ["owner"],
    tier,
  });
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Records a paid Checkout Session on its order — only when the account the
 * event came from is the one stored on the tenant the metadata names. */
async function applyPaidSession(deps: ConnectDeps, event: ConnectEvent, requestId: string) {
  const log = createLogger({ requestId });
  const session = event.data.object;
  if (session.payment_status !== "paid") return;

  const metadata = (session.metadata ?? {}) as Record<string, unknown>;
  const tenantId = str(metadata.graftTenantId);
  const orderId = str(metadata.graftOrderId);
  const amount = session.amount_total;
  if (!tenantId || !orderId || typeof amount !== "number" || amount <= 0) return;

  const tenant = await deps.store.find(tenantId);
  if (!tenant?.connect || !event.account || tenant.connect.accountId !== event.account) {
    log.warn("connect.webhook.account_mismatch", { eventId: event.id });
    return;
  }

  try {
    await deps.recordPayment(systemCtx(tenantId, tenant.tier, requestId), orderId, {
      amountMinor: amount,
      reference: str(session.payment_intent) ?? str(session.id) ?? undefined,
    });
  } catch (error) {
    // A cancelled or deleted order cannot take a payment. The money is in the
    // tenant's Stripe account either way; retrying would not change the answer.
    if (
      error instanceof AppError &&
      (error.code === "CONFLICT" || error.code === "NOT_FOUND")
    ) {
      log.warn("connect.webhook.order_unpayable", { eventId: event.id, code: error.code });
      return;
    }
    throw error;
  }
}

export async function handleConnectWebhookEvent(
  payload: string,
  signature: string | null,
  requestId: string,
  overrides: Partial<ConnectDeps> = {},
): Promise<void> {
  const deps = resolveDeps(overrides);
  if (!signature) throw new AppError("UNAUTHORIZED", "Missing signature");

  let event: ConnectEvent;
  try {
    event = await deps.stripe.constructEvent(
      payload,
      signature,
      deps.connectEnv().STRIPE_CONNECT_WEBHOOK_SECRET,
    );
  } catch {
    throw new AppError("UNAUTHORIZED", "Invalid signature");
  }

  if (!(await deps.events.claim(event.id, event.type, deps.now()))) return;

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        await applyPaidSession(deps, event, requestId);
        break;

      // Accounts are created with v2, but a v2 account with the merchant
      // configuration still emits this v1 snapshot event, in the "Connected
      // accounts" scope this endpoint already listens to — so no thin-event
      // destination is needed. The snapshot is v1-shaped, hence charges_enabled.
      case "account.updated": {
        if (!event.account) break;
        const tenantId = await deps.store.findTenantIdByAccount(event.account);
        if (!tenantId) break;
        const account = event.data.object;
        await deps.store.set(tenantId, {
          accountId: event.account,
          chargesEnabled: account.charges_enabled === true,
          detailsSubmitted: account.details_submitted === true,
          updatedAt: deps.now(),
        });
        break;
      }

      default:
        break;
    }
  } catch (error) {
    await deps.events.release(event.id);
    throw error;
  }
}
