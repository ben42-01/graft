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
import {
  applyDowngradePolicy,
  applyUpgrade,
  expireDueTrials,
  mongoBillingStore,
  startTrial,
  TRIAL_DAYS,
} from "./billing";

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

/**
 * GRAFT-26 AC4–AC7, AC9 — the trial-expiry entry point over a real `tenants`
 * collection. The selector is the part that only a real Mongo query can prove:
 * a `$ne: null, $lte: now` on a nested field, plus the `stripeSubscriptionId`
 * clause that keeps a paying customer out of the result set entirely.
 */
describe("expireDueTrials — GRAFT-26, real MongoDB", () => {
  const LAPSED = "000000000000000000000011";
  const LIVE = "000000000000000000000012";
  const ALREADY_FREE = "000000000000000000000013";
  const PAYING = "000000000000000000000014";

  const NOW_T = new Date("2026-06-10T00:00:00.000Z");
  const PAST = new Date("2026-06-01T00:00:00.000Z");
  const FUTURE = new Date("2026-06-20T00:00:00.000Z");

  const doc = (id: string, tier: "free" | "premium", billing: Record<string, unknown>) => ({
    _id: new ObjectId(id),
    name: `Trial ${id}`,
    slug: `trial-${id}`,
    tier,
    limits: { ...(tier === "premium" ? TIER_LIMITS.premium : TIER_LIMITS.free) },
    billing,
    billingAnchorDay: 1,
  });

  beforeEach(async () => {
    await (
      await tenants()
    ).insertMany([
      doc(LAPSED, "premium", {
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        trialEndsAt: PAST,
      }),
      doc(LIVE, "premium", {
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        trialEndsAt: FUTURE,
      }),
      doc(ALREADY_FREE, "free", {
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        trialEndsAt: PAST,
      }),
      // AC7 — upgraded during the trial, with the stale clock left behind.
      doc(PAYING, "premium", {
        stripeCustomerId: "cus_paying",
        stripeSubscriptionId: "sub_paying",
        trialEndsAt: PAST,
      }),
    ]);
  });

  const tierOf = async (id: string) =>
    (await (await tenants()).findOne({ _id: new ObjectId(id) }))?.tier;

  it("AC4, AC5, AC7 — downgrades exactly the lapsed trial and reports the count", async () => {
    const count = await expireDueTrials({ now: () => NOW_T });

    expect(count).toBe(1);
    expect(await tierOf(LAPSED)).toBe("free");
    // AC5 — the live trial keeps its tier, its limits and its clock.
    const live = await (await tenants()).findOne({ _id: new ObjectId(LIVE) });
    expect(live?.tier).toBe("premium");
    expect(live?.limits).toEqual(TIER_LIMITS.premium);
    expect(live?.billing?.trialEndsAt).toEqual(FUTURE);
    // AC7 — the paying customer is never even selected.
    expect(await tierOf(PAYING)).toBe("premium");
    expect(await tierOf(ALREADY_FREE)).toBe("free");
  });

  it("AC4 — the lapsed trial lands on Free by the existing downgrade path", async () => {
    await (
      await usageMeters()
    ).insertMany([
      { tenantId: new ObjectId(LAPSED), meter: "entities", period: "all", count: 10 },
      { tenantId: new ObjectId(LAPSED), meter: "records", period: "all", count: 3_000 },
    ]);
    const before = await (await tenants()).countDocuments();

    await expireDueTrials({ now: () => NOW_T });

    const tenant = await (await tenants()).findOne({ _id: new ObjectId(LAPSED) });
    expect(tenant?.tier).toBe("free");
    expect(tenant?.limits).toEqual(TIER_LIMITS.free);
    // Data retained, features locked, over-limit resources read-only.
    expect(new Set(tenant?.readOnly)).toEqual(new Set(["entities", "records"]));
    expect(await (await tenants()).countDocuments()).toBe(before);
  });

  it("AC6 — a second run changes nothing", async () => {
    await expireDueTrials({ now: () => NOW_T });
    const after = await (await tenants()).find({}).sort({ _id: 1 }).toArray();

    const second = await expireDueTrials({ now: () => NOW_T });

    expect(second).toBe(0);
    // The clock was consumed, so the selector cannot return the tenant again.
    expect(after.find((t) => t._id.toHexString() === LAPSED)?.billing?.trialEndsAt).toBeNull();
    expect(await (await tenants()).find({}).sort({ _id: 1 }).toArray()).toEqual(after);
  });

  it("AC1 — startTrial writes a 14-day clock through the port", async () => {
    const store = mongoBillingStore();
    await startTrial(ALREADY_FREE, { store, now: () => NOW_T });

    const snapshot = await store.findTenantById(ALREADY_FREE);
    expect(snapshot?.billing.trialEndsAt).toEqual(
      new Date(NOW_T.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000),
    );
  });
});
