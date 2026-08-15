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

  // Metering: one counter document per tenant/meter/period, atomically $inc'd
  {
    collection: "usage_meters",
    keys: { tenantId: 1, meter: 1, period: 1 },
    options: { unique: true },
  },

  // Audit log: 90-day retention on Premium (docs/TIERS.md §2.4)
  { collection: "audit_log", keys: { tenantId: 1, createdAt: -1 } },
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
