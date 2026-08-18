/**
 * The downgrade policy against a real MongoDB (GRAFT-15 AC4).
 *
 * "Nothing is ever deleted on downgrade" is a claim about the database, so it
 * is asserted where the database is: a real `forms` collection, a real
 * `mongoBillingStore`, and a document count taken before and after. Every
 * over-limit form is unpublished, never removed; every retained document
 * still has its original `name`/`slug`/`fields`. mongodb-memory-server rather
 * than the QA docker stack, for the same reason as meters.integration.test.ts
 * — CI runs `test:integration` before the QA stack is up, and a proof that
 * only runs locally is not a proof.
 */
import { ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getMongoClient } from "@/server/db/mongo";
import { TIER_LIMITS } from "@/server/tiers";
import { applyDowngradePolicy, applyUpgrade, mongoBillingStore } from "./billing";

const TENANT = "000000000000000000000001";
const NOW = new Date("2026-04-01T00:00:00.000Z");

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ instance: { dbName: "graft_billing" } });
  process.env.MONGODB_URI = mongod.getUri("graft_billing");
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  process.env.APP_ENV = "qa";

  const db = await getDb();
  // The production indexes (scripts/create-indexes.ts) that matter here.
  await db.collection("forms").createIndex({ tenantId: 1, slug: 1 }, { unique: true });
  await db
    .collection("usage_meters")
    .createIndex({ tenantId: 1, meter: 1, period: 1 }, { unique: true });
}, 120_000);

afterAll(async () => {
  await (await getMongoClient()).close();
  await mongod?.stop();
});

const forms = async () => (await getDb()).collection("forms");
const usageMeters = async () => (await getDb()).collection("usage_meters");
const tenants = async () => (await getDb()).collection("tenants");

beforeEach(async () => {
  await (await forms()).deleteMany({});
  await (await usageMeters()).deleteMany({});
  await (await tenants()).deleteMany({});

  await (
    await tenants()
  ).insertOne({
    _id: new ObjectId(TENANT),
    name: "Downgrade Test Tenant",
    slug: "downgrade-test",
    tier: "premium",
    limits: { ...TIER_LIMITS.premium },
    billingAnchorDay: 1,
  });
});

/** Over Free's `records` limit (2,000) and `entities` limit (3). */
async function seedOverLimitUsage() {
  await (
    await usageMeters()
  ).insertMany([
    { tenantId: new ObjectId(TENANT), meter: "entities", period: "all", count: 10 },
    { tenantId: new ObjectId(TENANT), meter: "records", period: "all", count: 3_000 },
  ]);
}

/** Free's `activeForms` limit is 2 (docs/TIERS.md §2.1) — three public,
 * published forms is one over. Distinct `createdAt` so the "oldest kept"
 * selection is deterministic. */
async function seedThreePublishedForms() {
  const base = {
    tenantId: new ObjectId(TENANT),
    entityDefId: new ObjectId(),
    visibility: "public",
    published: true,
    enabled: true,
    killSwitchAt: null,
    killSwitchBy: null,
    fields: [{ key: "name", label: "Name", type: "text", required: true }],
    showBadge: true,
    deletedAt: null,
    updatedAt: NOW,
  };
  await (
    await forms()
  ).insertMany([
    {
      ...base,
      name: "Oldest Form",
      slug: "oldest-form",
      publicSlug: "downgrade-test/oldest-form",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    {
      ...base,
      name: "Middle Form",
      slug: "middle-form",
      publicSlug: "downgrade-test/middle-form",
      createdAt: new Date("2026-02-01T00:00:00Z"),
    },
    {
      ...base,
      name: "Newest Form",
      slug: "newest-form",
      publicSlug: "downgrade-test/newest-form",
      createdAt: new Date("2026-03-01T00:00:00Z"),
    },
  ]);
}

describe("applyDowngradePolicy — AC4, real MongoDB", () => {
  it("never deletes a form — only unpublishes the over-limit ones, oldest kept", async () => {
    await seedThreePublishedForms();
    await seedOverLimitUsage();

    const before = await (await forms()).countDocuments({ tenantId: new ObjectId(TENANT) });
    expect(before).toBe(3);

    await applyDowngradePolicy(TENANT, { now: () => NOW });

    const after = await (await forms()).countDocuments({ tenantId: new ObjectId(TENANT) });
    expect(after).toBe(3);

    const all = await (
      await forms()
    )
      .find({ tenantId: new ObjectId(TENANT) })
      .sort({ createdAt: 1 })
      .toArray();
    // Oldest two kept active; the newest is the one over the new limit.
    expect(all.map((f) => [f.name, f.published, f.publicSlug])).toEqual([
      ["Oldest Form", true, "downgrade-test/oldest-form"],
      ["Middle Form", true, "downgrade-test/middle-form"],
      ["Newest Form", false, null],
    ]);
    // The unpublished form's definition survives intact — not a stub, the
    // real document with its real fields.
    expect(all[2]!.slug).toBe("newest-form");
    expect(all[2]!.fields).toEqual([
      { key: "name", label: "Name", type: "text", required: true },
    ]);
  });

  it("freezes over-limit entities/records read-only without touching any other collection", async () => {
    await seedOverLimitUsage();

    await applyDowngradePolicy(TENANT, { now: () => NOW });

    const tenant = await (await tenants()).findOne({ _id: new ObjectId(TENANT) });
    expect(tenant?.tier).toBe("free");
    expect(tenant?.limits).toEqual(TIER_LIMITS.free);
    expect(new Set(tenant?.readOnly)).toEqual(new Set(["entities", "records"]));
    expect(tenant?.downgradedAt).toEqual(NOW);

    // The usage counters themselves are untouched — read-only means "refuse
    // new writes", never "roll back what already happened".
    const entities = await (
      await usageMeters()
    ).findOne({
      tenantId: new ObjectId(TENANT),
      meter: "entities",
    });
    const records = await (
      await usageMeters()
    ).findOne({
      tenantId: new ObjectId(TENANT),
      meter: "records",
    });
    expect(entities?.count).toBe(10);
    expect(records?.count).toBe(3_000);
  });

  it("does not freeze a meter that was already within the new (Free) limit", async () => {
    await (
      await usageMeters()
    ).insertMany([
      { tenantId: new ObjectId(TENANT), meter: "entities", period: "all", count: 1 },
      { tenantId: new ObjectId(TENANT), meter: "records", period: "all", count: 5 },
    ]);

    await applyDowngradePolicy(TENANT, { now: () => NOW });

    const tenant = await (await tenants()).findOne({ _id: new ObjectId(TENANT) });
    expect(tenant?.readOnly).toEqual([]);
  });

  it("AC6 — re-subscribing clears the freeze and the unpublished form is still present, not republished", async () => {
    await seedThreePublishedForms();
    await seedOverLimitUsage();
    await applyDowngradePolicy(TENANT, { now: () => NOW });

    await applyUpgrade(TENANT, "premium");

    const tenant = await (await tenants()).findOne({ _id: new ObjectId(TENANT) });
    expect(tenant?.tier).toBe("premium");
    expect(tenant?.limits).toEqual(TIER_LIMITS.premium);
    expect(tenant?.readOnly).toEqual([]);
    expect(tenant?.downgradedAt).toBeNull();

    const afterUpgrade = await (
      await forms()
    ).countDocuments({ tenantId: new ObjectId(TENANT) });
    expect(afterUpgrade).toBe(3);
    const newest = await (await forms()).findOne({ slug: "newest-form" });
    // Retained, present, and readable — but not auto-republished (AC6's own
    // wording: "the previously unpublished forms still present", not "still
    // published").
    expect(newest).not.toBeNull();
    expect(newest?.published).toBe(false);
  });
});

describe("mongoBillingStore — port smoke test against a real tenant document", () => {
  it("round-trips a Stripe customer id", async () => {
    const store = mongoBillingStore();
    await store.setStripeCustomerId(TENANT, "cus_integration_test");
    const snapshot = await store.findTenantById(TENANT);
    expect(snapshot?.billing.stripeCustomerId).toBe("cus_integration_test");

    const byCustomer = await store.findTenantByStripeCustomerId("cus_integration_test");
    expect(byCustomer?.id).toBe(TENANT);
  });
});
