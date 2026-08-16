/**
 * Entitlements — what a tenant is allowed to *have* (GRAFT-05, docs/TIERS.md §4).
 *
 * PROTECTED PATH (.github/agent-policy.yml): this file and ./meters.ts are the
 * only place a tier decision is made. Everything else — routes, UI, plugins —
 * asks; nothing else decides.
 *
 * Three properties are structural, and each one is a rule the ACs pin down:
 *
 *   - **The tenant document is the source of truth, not the tier constant and
 *     not the token.** `TIER_LIMITS[tier]` is only the default; whatever the
 *     tenant carries in `tenants.limits` wins, which is how an Enterprise deal
 *     ships without a code change (AC1, AC2). `ctx.tier` is a 15-minute-old
 *     claim from an access token and is never consulted for a grant.
 *   - **Overrides are whitelisted, never spread.** `tenants.limits` is data, and
 *     data that decides permissions is attacker-shaped the moment anything can
 *     write to it. Only known keys with the right type are copied across.
 *   - **`null` is unlimited, and is never allowed to decay into 0.** Every
 *     comparison against a limit goes through code that branches on `null`
 *     first (AC8), which is why the resolved limit is not just a number.
 *
 * `tenants` is a global collection keyed by `_id` — the same argument as
 * src/server/auth/accounts-store.ts — so it is read directly rather than
 * through the ctx-injecting repository layer, which scopes *by* tenantId and
 * therefore cannot fetch the tenant itself. The read is still by `ctx.tenantId`
 * and nothing else.
 */
import { ObjectId } from "mongodb";
import type { Ctx } from "@/server/context";
import { getDb } from "@/server/db/mongo";
import { AppError } from "@/server/http/envelope";
import {
  FEATURES,
  LIMIT_KEYS,
  TIER_FEATURES,
  TIER_LIMITS,
  TIERS,
  type Feature,
  type Tier,
  type TierFeatures,
  type TierLimits,
} from "@/server/tiers";

/**
 * What may be written onto `tenants.limits`. Numeric caps and capability grants
 * share one document on purpose: an Enterprise negotiation is a single edit, and
 * "the limits object" is the one thing the UI reads to render entitlement.
 */
export type LimitOverrides = Partial<Record<keyof TierLimits, number | null>> &
  Partial<Record<Feature, boolean>>;

/** The slice of the tenant document entitlement decisions depend on. */
export type TenantSnapshot = {
  id: string;
  tier: Tier;
  limits: LimitOverrides;
  /**
   * Resources a downgrade froze (docs/TIERS.md §4). Nothing is ever deleted; the
   * over-limit rows stay readable and stop accepting writes. The values are meter
   * keys (see ./meters.ts) held as plain strings so this module stays a leaf.
   */
  readOnly: readonly string[];
  downgradedAt: Date | null;
  /** Day of month the billing period rolls over — the anniversary, not the 1st. */
  billingAnchorDay: number;
};

export type Entitlements = Readonly<{
  tenantId: string;
  tier: Tier;
  limits: TierLimits;
  features: TierFeatures;
  readOnly: readonly string[];
  downgradedAt: Date | null;
  billingAnchorDay: number;
}>;

export type EntitlementStore = {
  findTenant(tenantId: string): Promise<TenantSnapshot | null>;
};

export type EntitlementDeps = { store: EntitlementStore };

const DEFAULT_ANCHOR_DAY = 1;

/** A cap is a non-negative integer or `null`; anything else is not a cap. */
const isLimitValue = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);

const isString = (value: unknown): value is string => typeof value === "string";

const clampAnchorDay = (day: unknown): number =>
  typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 31
    ? day
    : DEFAULT_ANCHOR_DAY;

/**
 * AC1, AC2, AC8. Tier defaults first, per-tenant overrides on top, one known key
 * at a time. The result is a complete object: every limit key and every feature
 * key is present, so no caller ever has to distinguish "absent" from "false".
 */
export function resolveEntitlements(tenant: TenantSnapshot): Entitlements {
  const tier: Tier = TIERS.includes(tenant.tier) ? tenant.tier : "free";
  const overrides: LimitOverrides = tenant.limits ?? {};

  const limits = { ...TIER_LIMITS[tier] };
  for (const key of LIMIT_KEYS) {
    const value = overrides[key];
    // `undefined` means "not overridden"; a malformed value means the same,
    // because a bad row must never silently widen or close a tenant's plan.
    if (value !== undefined && isLimitValue(value)) limits[key] = value;
  }

  const features = { ...TIER_FEATURES[tier] };
  for (const key of FEATURES) {
    const value = overrides[key];
    if (typeof value === "boolean") features[key] = value;
  }

  return Object.freeze({
    tenantId: tenant.id,
    tier,
    limits,
    features,
    readOnly: Array.isArray(tenant.readOnly) ? [...tenant.readOnly] : [],
    downgradedAt: tenant.downgradedAt ?? null,
    billingAnchorDay: clampAnchorDay(tenant.billingAnchorDay),
  });
}

type TenantDoc = {
  _id: ObjectId;
  tier?: string;
  limits?: LimitOverrides;
  readOnly?: unknown;
  downgradedAt?: Date | null;
  billingAnchorDay?: number;
  createdAt?: Date;
};

export function mongoEntitlementStore(): EntitlementStore {
  return {
    async findTenant(tenantId) {
      if (!ObjectId.isValid(tenantId)) return null;
      const db = await getDb();
      const doc = await db
        .collection<TenantDoc>("tenants")
        .findOne({ _id: new ObjectId(tenantId) });
      if (!doc) return null;
      return {
        id: doc._id.toHexString(),
        tier: (TIERS.includes(doc.tier as Tier) ? doc.tier : "free") as Tier,
        limits: doc.limits ?? {},
        readOnly: Array.isArray(doc.readOnly) ? doc.readOnly.filter(isString) : [],
        downgradedAt: doc.downgradedAt ?? null,
        // No explicit anchor yet (Stripe sets one in GRAFT-15), so the tenant's
        // own creation day is the anniversary — which is what it will be anyway.
        billingAnchorDay:
          doc.billingAnchorDay ?? doc.createdAt?.getUTCDate() ?? DEFAULT_ANCHOR_DAY,
      };
    },
  };
}

function resolveDeps(overrides: Partial<EntitlementDeps> = {}): EntitlementDeps {
  return { store: overrides.store ?? mongoEntitlementStore() };
}

/**
 * The one read. A tenant that has vanished mid-session is a FORBIDDEN, not an
 * empty entitlement set: defaulting to "Free" here would quietly grant the Free
 * plan to a token for a deleted workspace.
 */
export async function loadEntitlements(
  ctx: Ctx,
  overrides: Partial<EntitlementDeps> = {},
): Promise<Entitlements> {
  const { store } = resolveDeps(overrides);
  const tenant = await store.findTenant(ctx.tenantId);
  if (!tenant) throw new AppError("FORBIDDEN", "You are not a member of that workspace");
  return resolveEntitlements(tenant);
}

/** Pure capability check over an already-loaded entitlement object — this is the
 * same object the UI renders from (docs/TIERS.md §4), which is why it is exported. */
export function allows(entitlements: Entitlements, feature: Feature): boolean {
  return entitlements.features[feature] === true;
}

/**
 * AC1. Asynchronous because the answer lives in `tenants.limits` and a document
 * read is a document read — see "Outside guidance" in the PR. Call sites that
 * make several checks should `loadEntitlements` once and use `allows`.
 */
export async function can(
  ctx: Ctx,
  feature: Feature,
  overrides: Partial<EntitlementDeps> = {},
): Promise<boolean> {
  return allows(await loadEntitlements(ctx, overrides), feature);
}

/** `null` is unlimited. Callers must branch on it rather than coalescing to 0. */
export function limitFor(entitlements: Entitlements, key: keyof TierLimits): number | null {
  return entitlements.limits[key];
}

/** AC7 — frozen by a downgrade: still readable, no longer writable. */
export function isReadOnly(entitlements: Entitlements, resource: string): boolean {
  return entitlements.readOnly.includes(resource);
}

export function assertWritable(entitlements: Entitlements, resource: string): void {
  if (!isReadOnly(entitlements, resource)) return;
  throw new AppError(
    "QUOTA_EXCEEDED",
    "This is read-only on your current plan. Upgrade to make changes; nothing has been deleted.",
    { resource, reason: "read_only" },
  );
}
