/**
 * Idempotent index creation — safe to run on every deploy, in every environment
 * (docs/WORKFLOW.md §5.5, docs/BACKEND.md §6).
 *
 * `createIndex` is a no-op when an identical index already exists, so this is
 * the same mechanism dev, qa and prod use. No snowflake production indexes.
 */
import type { Db, IndexSpecification, CreateIndexesOptions } from "mongodb";
import { connect } from "./lib/db";

type IndexDef = {
  collection: string;
  keys: IndexSpecification;
  options?: CreateIndexesOptions;
};

const INDEXES: IndexDef[] = [
  // Tenancy roots
  { collection: "tenants", keys: { slug: 1 }, options: { unique: true } },
  { collection: "users", keys: { email: 1 }, options: { unique: true } },
  { collection: "users", keys: { "memberships.tenantId": 1 } },

  // Every tenant-scoped collection leads with tenantId — the isolation boundary
  // is also the index prefix, so a query that forgets it cannot be fast enough
  // to go unnoticed.
  {
    collection: "plugins_enabled",
    keys: { tenantId: 1, pluginId: 1 },
    options: { unique: true },
  },
  { collection: "entity_defs", keys: { tenantId: 1, key: 1 }, options: { unique: true } },
  { collection: "records", keys: { tenantId: 1, entityDefId: 1, updatedAt: -1 } },
  { collection: "records", keys: { tenantId: 1, entityDefId: 1, deletedAt: 1 } },
  { collection: "forms", keys: { tenantId: 1, slug: 1 }, options: { unique: true } },
  // Public form lookup by URL: /f/{tenantSlug}/{formSlug}
  {
    collection: "forms",
    keys: { publicSlug: 1 },
    options: { unique: true, partialFilterExpression: { publicSlug: { $type: "string" } } },
  },
  { collection: "form_submissions", keys: { tenantId: 1, formId: 1, createdAt: -1 } },
  { collection: "dashboards", keys: { tenantId: 1, ownerId: 1 } },
  // One onboarding_state document per tenant (GRAFT-12 AC2, AC7).
  { collection: "onboarding_state", keys: { tenantId: 1 }, options: { unique: true } },

  // Media: the only query is "the ready objects owned by this thing", which is
  // how a form builder lists its carousel and how orphan sweeping will find
  // abandoned `pending` rows.
  { collection: "media", keys: { tenantId: 1, ownerType: 1, ownerId: 1, status: 1 } },

  // Inventory (docs/BMS_EXTENSION.md §3.1, Step 1). One pool per bookable
  // record — the uniqueness is the model, not an optimisation.
  {
    collection: "inventory_pools",
    keys: { tenantId: 1, recordId: 1 },
    options: { unique: true },
  },
  // "Every bookable thing of this type", which is how a scheduler enumerates
  // resources before drawing a timeline.
  { collection: "inventory_pools", keys: { tenantId: 1, entityDefId: 1 } },

  // The availability query, and the reason it can be fast: §3.1 Step 1 asks
  // for "(entity_id, start_time, end_time)". The pool is the tighter prefix
  // here (a pool belongs to exactly one entity type), and the range is over
  // the *blocked* window — buffers baked in at write time — because that is
  // what an overlap actually means (src/server/services/availability.ts).
  {
    collection: "resource_allocations",
    keys: { tenantId: 1, poolId: 1, blockedFrom: 1, blockedUntil: 1 },
  },
  // "Everything allocated to this order", for an invoice or a cancellation.
  { collection: "resource_allocations", keys: { tenantId: 1, holderId: 1 } },
  // Abandoned checkout holds are swept by Mongo rather than by a cron we would
  // forget. Deliberately *after* the lease expires, not at it: availability
  // already ignores a lapsed hold the instant it lapses, so this only reclaims
  // space — and the day's grace keeps abandoned checkouts readable for anyone
  // asking why a customer did not complete one. Confirmed rows carry
  // `expiresAt: null` and the TTL monitor skips them.
  {
    collection: "resource_allocations",
    keys: { expiresAt: 1 },
    options: { expireAfterSeconds: 60 * 60 * 24 },
  },

  // Metering: one counter document per tenant/meter/period, atomically $inc'd
  {
    collection: "usage_meters",
    keys: { tenantId: 1, meter: 1, period: 1 },
    options: { unique: true },
  },

  // Audit log: 90-day retention on Premium (docs/TIERS.md §2.4)
  { collection: "audit_log", keys: { tenantId: 1, createdAt: -1 } },

  // Refresh tokens (docs/BACKEND.md §3.1). The lookup is (tenantId, tokenHash)
  // and it is unique: one stored hash can never resolve to two families.
  {
    collection: "refresh_tokens",
    keys: { tenantId: 1, tokenHash: 1 },
    options: { unique: true },
  },
  // Reuse detection revokes by family, so the family is an index, not a scan.
  { collection: "refresh_tokens", keys: { tenantId: 1, familyId: 1 } },
  // Expired tokens are swept by Mongo rather than by a cron we would forget.
  // Deliberately *after* the 30-day expiry, not instead of it: the application
  // refuses an expired token itself, and the TTL monitor only reclaims space.
  {
    collection: "refresh_tokens",
    keys: { expiresAt: 1 },
    options: { expireAfterSeconds: 60 * 60 * 24 },
  },

  // Email verification (GRAFT-03.2 AC3). The lookup is by hash alone — there is
  // no session at verification time to scope it by — so it must be unique, or
  // one presented token could match two rows and "single use" would be a lie.
  {
    collection: "email_verification_tokens",
    keys: { tokenHash: 1 },
    options: { unique: true },
  },
  // Same reasoning as the refresh sweep: the application refuses an expired
  // token itself, and the TTL monitor only reclaims the space afterwards.
  {
    collection: "email_verification_tokens",
    keys: { expiresAt: 1 },
    options: { expireAfterSeconds: 60 * 60 * 24 },
  },
];

async function main() {
  const { client, db } = await connect();
  try {
    let created = 0;
    for (const def of INDEXES) {
      const name = await ensureIndex(db, def);
      console.log(`  ✓ ${def.collection}.${name}`);
      created++;
    }
    console.log(`[graft] ${created} indexes ensured on '${db.databaseName}'`);
  } finally {
    await client.close();
  }
}

async function ensureIndex(db: Db, { collection, keys, options }: IndexDef) {
  return db.collection(collection).createIndex(keys, options ?? {});
}

main().catch((error) => {
  console.error("[graft] index creation failed:", error);
  process.exit(1);
});
