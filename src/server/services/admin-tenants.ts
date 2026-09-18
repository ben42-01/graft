/**
 * Cross-tenant tenant reads for the platform-admin surface (GRAFT-27.2).
 *
 * This is the first service in the product that deliberately reads *across*
 * tenants, so three decisions are worth reading before changing anything here.
 *
 * ## 1. `tenants` is read directly, not through the repository layer
 *
 * The ctx-injecting repository (src/server/repositories/base.ts) scopes every
 * query *by* `ctx.tenantId`, which is exactly the wrong thing for a surface
 * whose whole job is to span tenants — and it cannot fetch a tenant document
 * anyway, since `tenants` is a global collection keyed by `_id`. The same
 * argument is already written down in entitlements.ts, billing.ts and
 * auth/accounts-store.ts, and this module follows that precedent rather than
 * inventing a new one.
 *
 * The consequence is that **the repository is not protecting these reads** —
 * `assertPlatformAdmin` (src/server/auth/platform-admin.ts) is the only thing
 * that is. `createRepository` is therefore never called from this file, and
 * admin-tenants.test.ts mocks it to throw so that a future edit which reaches
 * for it fails the suite instead of quietly scoping the admin console to
 * whichever workspace the admin happens to be signed in to (AC10).
 *
 * ## 2. Every field is an explicit allow-list, never a spread
 *
 * `toTenantSummary` / `toTenantDetail` name every key they emit. There is no
 * `...tenant` anywhere in this file, and that is the mechanism behind AC8: a
 * field added to the tenant document tomorrow — a Stripe id, a contact email,
 * an internal note — does not appear in an API response because nobody
 * remembered to strip it. It does not appear because nobody added it here.
 *
 * Billing is reported as presence, not identity: `hasCustomer` /
 * `hasSubscription` booleans. The admin console needs to know whether a tenant
 * is wired to Stripe; it never needs the id, and an id in a response body is an
 * id in a browser history, a screenshot and a support ticket.
 *
 * ## 3. `q` is text, and is escaped before it reaches Mongo
 *
 * A `$regex` built from a request is a pattern the caller wrote. `.*` would
 * match everything and a catastrophic pattern would pin a core, so the term is
 * escaped to a literal (AC3) — the same treatment public-catalogue.ts gives
 * visitor search. `tier` is a Zod enum, so an unknown value is a 400 rather
 * than a silently empty list (AC4).
 */
import { ObjectId, type Filter } from "mongodb";
import { z } from "zod";
import { getDb } from "@/server/db/mongo";
import { AppError } from "@/server/http/envelope";
import { clampLimit, decodeCursor, page, type PageMeta } from "@/server/http/pagination";
import { TIERS, type Tier } from "@/server/tiers";
import {
  resolveEntitlements,
  type Entitlements,
  type LimitOverrides,
} from "@/server/services/entitlements";

/** The slice of a tenant document this surface reads. Nothing else is fetched. */
export type AdminTenantDoc = {
  _id: ObjectId;
  name?: string;
  slug?: string;
  tier?: string;
  createdAt?: Date;
  limits?: LimitOverrides;
  readOnly?: unknown;
  downgradedAt?: Date | null;
  billingAnchorDay?: number;
  billing?: {
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    graceExpiresAt?: Date | null;
    trialEndsAt?: Date | null;
  };
};

/** Presence, never identity — see the header note on AC8. */
export type AdminTenantBilling = Readonly<{
  hasCustomer: boolean;
  hasSubscription: boolean;
  graceExpiresAt: string | null;
  trialEndsAt: string | null;
}>;

export type TenantSummary = Readonly<{
  id: string;
  name: string;
  slug: string;
  tier: Tier;
  createdAt: string | null;
  readOnlyCount: number;
  hasLimitOverrides: boolean;
  billing: AdminTenantBilling;
}>;

export type TenantDetail = TenantSummary &
  Readonly<{
    /** The resolved entitlement object — what the tenant actually has (AC5). */
    limits: Entitlements;
    /** The raw per-tenant override bag as stored on the document (AC5). */
    limitOverrides: LimitOverrides;
    readOnly: readonly string[];
    downgradedAt: string | null;
    billingAnchorDay: number;
  }>;

export type AdminTenantStore = {
  /** One over-fetched page, descending `_id`. The filter is built here, never by a caller. */
  listTenants(filter: Filter<AdminTenantDoc>, limit: number): Promise<AdminTenantDoc[]>;
  findTenant(tenantId: string): Promise<AdminTenantDoc | null>;
};

export type AdminTenantDeps = { store: AdminTenantStore };

/** Long enough for any workspace name; short enough that a query stays a query. */
export const MAX_SEARCH_LENGTH = 60;

const objectIdHex = /^[0-9a-f]{24}$/i;

export const adminTenantListQuerySchema = z.object({
  q: z.string().max(MAX_SEARCH_LENGTH).optional(),
  // AC4 — an unknown tier is a 400 at the boundary, not an empty list.
  tier: z.enum(TIERS).optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
});

export type AdminTenantListQuery = z.infer<typeof adminTenantListQuerySchema>;

export const adminTenantParamsSchema = z.object({
  tenantId: z.string().regex(objectIdHex, "Expected a 24-character id"),
});

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isString = (value: unknown): value is string => typeof value === "string";

const readOnlyList = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter(isString) : [];

const iso = (value: unknown): string | null =>
  value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null;

const tierOf = (raw: unknown): Tier => (TIERS.includes(raw as Tier) ? (raw as Tier) : "free");

const overridesOf = (doc: AdminTenantDoc): LimitOverrides =>
  doc.limits && typeof doc.limits === "object" ? doc.limits : {};

/**
 * AC1 + AC8. Every key is written out by hand. Do not replace any of this with
 * a spread, however tempting: the allow-list *is* the security control.
 */
export function toTenantSummary(doc: AdminTenantDoc): TenantSummary {
  const billing = doc.billing ?? {};
  return Object.freeze({
    id: doc._id.toHexString(),
    name: isString(doc.name) ? doc.name : "",
    slug: isString(doc.slug) ? doc.slug : "",
    tier: tierOf(doc.tier),
    createdAt: iso(doc.createdAt),
    readOnlyCount: readOnlyList(doc.readOnly).length,
    // "Carries a non-empty override bag" — not "differs from the tier default".
    // The console uses it to decide whether the detail view is worth opening.
    hasLimitOverrides: Object.keys(overridesOf(doc)).length > 0,
    billing: Object.freeze({
      hasCustomer: Boolean(billing.stripeCustomerId),
      hasSubscription: Boolean(billing.stripeSubscriptionId),
      graceExpiresAt: iso(billing.graceExpiresAt),
      trialEndsAt: iso(billing.trialEndsAt),
    }),
  });
}

/**
 * AC5. The `limits` field is the *resolved* entitlement object, so the console
 * shows what the tenant is entitled to rather than the tier's default; the raw
 * override bag rides alongside as `limitOverrides` so an operator can still see
 * what was negotiated. `resolveEntitlements` is imported and not re-implemented
 * — entitlements.ts is the only place a tier decision is made, and this file
 * makes none.
 */
export function toTenantDetail(doc: AdminTenantDoc): TenantDetail {
  const overrides = overridesOf(doc);
  const readOnly = readOnlyList(doc.readOnly);
  const entitlements = resolveEntitlements({
    id: doc._id.toHexString(),
    tier: tierOf(doc.tier),
    limits: overrides,
    readOnly,
    downgradedAt: doc.downgradedAt ?? null,
    billingAnchorDay: doc.billingAnchorDay ?? doc.createdAt?.getUTCDate() ?? 1,
  });
  return Object.freeze({
    ...toTenantSummary(doc),
    limits: entitlements,
    limitOverrides: overrides,
    readOnly: entitlements.readOnly,
    downgradedAt: iso(entitlements.downgradedAt),
    billingAnchorDay: entitlements.billingAnchorDay,
  });
}

type TenantFilter = Filter<AdminTenantDoc>;

/** Built here, from validated input only — a client filter never reaches Mongo. */
export function buildTenantFilter(query: AdminTenantListQuery): TenantFilter {
  const filter: TenantFilter = {};

  if (query.tier) filter.tier = query.tier;

  if (query.cursor) {
    // `decodeCursor` refuses anything this API did not issue, so a crafted
    // cursor is a 400 rather than an unbounded scan.
    filter._id = { $lt: new ObjectId(decodeCursor(query.cursor).id) };
  }

  const q = isString(query.q) ? query.q.trim().slice(0, MAX_SEARCH_LENGTH) : "";
  if (q) {
    const $regex = escapeRegex(q);
    filter.$or = [
      { name: { $regex, $options: "i" } },
      { slug: { $regex, $options: "i" } },
    ] as TenantFilter["$or"];
  }

  return filter;
}

export function mongoAdminTenantStore(): AdminTenantStore {
  return {
    async listTenants(filter, limit) {
      const db = await getDb();
      return (
        db
          .collection<AdminTenantDoc>("tenants")
          .find(filter)
          // Descending `_id` is the stable sort the opaque cursor is issued
          // against (AC2): newest first, and unique, so no row can straddle a
          // page boundary the way a `createdAt` tie could.
          .sort({ _id: -1 })
          .limit(limit)
          .toArray()
      );
    },
    async findTenant(tenantId) {
      if (!ObjectId.isValid(tenantId)) return null;
      const db = await getDb();
      return db.collection<AdminTenantDoc>("tenants").findOne({ _id: new ObjectId(tenantId) });
    },
  };
}

function resolveDeps(overrides: Partial<AdminTenantDeps> = {}): AdminTenantDeps {
  return { store: overrides.store ?? mongoAdminTenantStore() };
}

/**
 * AC1–AC4. One page of every tenant in the database, in no way narrowed by the
 * caller's own membership. The query is re-validated here rather than trusted
 * from the route, so a direct service call cannot smuggle an unknown tier past
 * the Zod boundary.
 */
export async function listAdminTenants(
  query: unknown,
  overrides: Partial<AdminTenantDeps> = {},
): Promise<{ items: TenantSummary[]; meta: PageMeta }> {
  const parsed = adminTenantListQuerySchema.safeParse(query ?? {});
  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", "Invalid request query", {
      source: "query",
      fields: Object.fromEntries(
        parsed.error.issues.map((issue) => [issue.path.join(".") || "(root)", issue.message]),
      ),
    });
  }

  const { store } = resolveDeps(overrides);
  const limit = clampLimit(parsed.data.limit);
  // One extra row is how `hasMore` is known without a second count query.
  const rows = await store.listTenants(buildTenantFilter(parsed.data), limit + 1);
  const paged = page(rows, limit, (row) => ({ id: row._id.toHexString() }));
  return { items: paged.items.map(toTenantSummary), meta: paged.meta };
}

/**
 * AC5 + AC6. A bad id is a 400 and a missing tenant is a 404; neither is ever
 * allowed to become a BSONError surfacing as a 500 — which is why the hex check
 * happens before `new ObjectId(...)` is anywhere near the driver.
 */
export async function getAdminTenant(
  tenantId: unknown,
  overrides: Partial<AdminTenantDeps> = {},
): Promise<TenantDetail> {
  const parsed = adminTenantParamsSchema.safeParse({ tenantId });
  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", "Invalid request params", {
      source: "params",
      fields: { tenantId: "Expected a 24-character id" },
    });
  }

  const { store } = resolveDeps(overrides);
  const doc = await store.findTenant(parsed.data.tenantId);
  if (!doc) throw new AppError("NOT_FOUND", "No such tenant");
  return toTenantDetail(doc);
}
