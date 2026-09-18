/**
 * GRAFT-27.4 AC2 — "and **no document is deleted**" — against a real MongoDB.
 *
 * This is the claim that cannot honestly be made against a double. A store
 * double proves the service *asked* for the right transition; only a real
 * database proves that after the transition every record, every form
 * definition and every submission is still there. So this file counts the
 * collections before and after a premium → free override and asserts the
 * counts are identical, then asserts the surviving documents are the same
 * documents (by `_id` and by content), not replacements or stubs.
 *
 * It drives `overrideTenantTier` end to end — the real `mongoBillingStore`,
 * the real `mongoAdminTenantStore`, the real `mongoAdminAuditStore`, the real
 * `applyDowngradePolicy` underneath — so what is proven here is the endpoint's
 * behaviour, not a fixture's.
 *
 * mongodb-memory-server rather than the QA docker stack, for the same reason
 * as billing.integration.test.ts: CI runs `test:integration` before the QA
 * stack is up, and a proof that only runs locally is not a proof.
 */
import { ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getMongoClient } from "@/server/db/mongo";
import { TIER_LIMITS } from "@/server/tiers";
import { ADMIN_AUDIT_COLLECTION } from "./admin-audit";
import { deferredAdminAudit, overrideTenantTier } from "./admin-tier";
import { LIFETIME_PERIOD } from "./meters";

const TENANT = "000000000000000000000001";
const ACTOR = "000000000000000000000080";
const NOW = new Date("2026-09-18T12:00:00.000Z");

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ instance: { dbName: "graft_admin_tier" } });
  process.env.MONGODB_URI = mongod.getUri("graft_admin_tier");
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  process.env.APP_ENV = "qa";

  const db = await getDb();
  await db.collection("forms").createIndex({ tenantId: 1, slug: 1 }, { unique: true });
  await db
    .collection("usage_meters")
    .createIndex({ tenantId: 1, meter: 1, period: 1 }, { unique: true });
}, 120_000);

afterAll(async () => {
  await (await getMongoClient()).close();
  await mongod?.stop();
});

const col = async (name: string) => (await getDb()).collection(name);
const tenantOid = new ObjectId(TENANT);

/** Every collection whose document count AC2 says must not move. */
const COUNTED = ["records", "forms", "form_submissions", "entity_defs"] as const;

async function counts(): Promise<Record<string, number>> {
  const entries = await Promise.all(
    COUNTED.map(async (name) => [name, await (await col(name)).countDocuments({})] as const),
  );
  return Object.fromEntries(entries);
}

async function ids(name: string): Promise<string[]> {
  const docs = await (await col(name)).find({}).project({ _id: 1 }).toArray();
  return docs.map((doc) => String(doc._id)).sort();
}

/** Deferred sink pre-loaded with the row `assertPlatformAdmin` would have written. */
async function auditForThisCall() {
  const deferred = deferredAdminAudit();
  await deferred.sink.append({
    actorUserId: ACTOR,
    action: "admin.tenant.tier",
    targetTenantId: TENANT,
    requestId: "req-integration-1",
    at: NOW,
  });
  return deferred;
}

beforeEach(async () => {
  const db = await getDb();
  for (const name of [...COUNTED, "tenants", "usage_meters", ADMIN_AUDIT_COLLECTION]) {
    await db.collection(name).deleteMany({});
  }

  await db.collection("tenants").insertOne({
    _id: tenantOid,
    name: "Over Limit Co",
    slug: "over-limit-co",
    tier: "premium",
    limits: { ...TIER_LIMITS.premium },
    readOnly: [],
    downgradedAt: null,
    billingAnchorDay: 1,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });

  // Well over Free's caps on both frozen meters (entities 3, records 2,000).
  await db.collection("usage_meters").insertMany([
    { tenantId: tenantOid, meter: "entities", period: LIFETIME_PERIOD, count: 11 },
    { tenantId: tenantOid, meter: "records", period: LIFETIME_PERIOD, count: 4_200 },
  ]);

  const entityDefId = new ObjectId();
  await db.collection("entity_defs").insertOne({
    _id: entityDefId,
    tenantId: tenantOid,
    key: "guests",
    name: "Guests",
    fields: [{ key: "name", label: "Name", type: "text" }],
    deletedAt: null,
  });

  // Real records — the documents AC2 is really about. A downgrade freezes the
  // meter; it does not remove a single row of a customer's data.
  await db.collection("records").insertMany(
    Array.from({ length: 25 }, (_, n) => ({
      _id: new ObjectId(),
      tenantId: tenantOid,
      entityDefId,
      data: { name: `Guest ${n}` },
      createdAt: new Date(`2026-02-${String((n % 27) + 1).padStart(2, "0")}T00:00:00.000Z`),
      deletedAt: null,
    })),
  );

  // Five public published forms against Free's cap of two: three must be
  // unpublished, none removed. Distinct createdAt so "oldest kept" is exact.
  const formBase = {
    tenantId: tenantOid,
    entityDefId,
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
  await db.collection("forms").insertMany(
    ["01", "02", "03", "04", "05"].map((month, n) => ({
      ...formBase,
      _id: new ObjectId(),
      name: `Form ${n}`,
      slug: `form-${n}`,
      publicSlug: `over-limit-co/form-${n}`,
      createdAt: new Date(`2026-${month}-01T00:00:00.000Z`),
    })),
  );

  await db.collection("form_submissions").insertMany(
    Array.from({ length: 7 }, () => ({
      _id: new ObjectId(),
      tenantId: tenantOid,
      data: { name: "Someone" },
      createdAt: NOW,
    })),
  );
});

describe("overrideTenantTier — AC2 against a real MongoDB", () => {
  it("freezes over-limit meters and unpublishes overflow forms while deleting nothing", async () => {
    const before = await counts();
    const recordIdsBefore = await ids("records");
    const formIdsBefore = await ids("forms");
    expect(before.records).toBe(25);
    expect(before.forms).toBe(5);

    const result = await overrideTenantTier(
      {
        tenantId: TENANT,
        body: { tier: "free", reason: "refund issued — dropping to free" },
        audit: await auditForThisCall(),
      },
      { billing: { now: () => NOW } },
    );

    // --- AC2's "nothing is deleted", stated as plainly as it can be stated.
    const after = await counts();
    expect(after).toEqual(before);
    // Same documents, not merely the same number of them.
    expect(await ids("records")).toEqual(recordIdsBefore);
    expect(await ids("forms")).toEqual(formIdsBefore);

    // --- and the transition really did happen.
    const tenant = await (await col("tenants")).findOne({ _id: tenantOid });
    expect(tenant?.tier).toBe("free");
    expect(tenant?.limits).toEqual(TIER_LIMITS.free);
    expect(tenant?.readOnly).toEqual(["entities", "records"]);
    expect(tenant?.downgradedAt).toEqual(NOW);

    expect(result).toMatchObject({
      id: TENANT,
      fromTier: "premium",
      toTier: "free",
      changed: true,
      readOnly: ["entities", "records"],
    });
  });

  it("unpublishes exactly the overflow forms, oldest kept, and leaves their definitions intact", async () => {
    await overrideTenantTier(
      {
        tenantId: TENANT,
        body: { tier: "free", reason: "refund issued" },
        audit: await auditForThisCall(),
      },
      { billing: { now: () => NOW } },
    );

    const forms = await (await col("forms")).find({}).sort({ createdAt: 1 }).toArray();
    expect(forms).toHaveLength(5);
    // Free's activeForms cap is 2 — the two oldest stay published.
    expect(forms.map((form) => form.published)).toEqual([true, true, false, false, false]);
    // The unpublished ones are complete definitions, not tombstones.
    for (const form of forms) {
      expect(form.deletedAt).toBeNull();
      expect(form.fields).toHaveLength(1);
      expect(form.name).toMatch(/^Form \d$/);
    }
  });

  it("records are still readable after the freeze — readOnly is a flag, not a deletion", async () => {
    await overrideTenantTier(
      {
        tenantId: TENANT,
        body: { tier: "free", reason: "refund issued" },
        audit: await auditForThisCall(),
      },
      { billing: { now: () => NOW } },
    );

    const records = await (await col("records")).find({ tenantId: tenantOid }).toArray();
    expect(records).toHaveLength(25);
    expect(records.every((record) => record.deletedAt === null)).toBe(true);
    expect(records[0]?.data).toMatchObject({ name: expect.stringContaining("Guest") });
  });

  it("AC7 — exactly one audit row lands in admin_audit_log, carrying the outcome", async () => {
    await overrideTenantTier(
      {
        tenantId: TENANT,
        body: { tier: "free", reason: "refund issued" },
        audit: await auditForThisCall(),
      },
      { billing: { now: () => NOW } },
    );

    const rows = await (await col(ADMIN_AUDIT_COLLECTION)).find({}).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "admin.tenant.tier",
      fromTier: "premium",
      toTier: "free",
      reason: "refund issued",
      changed: true,
      ok: true,
      requestId: "req-integration-1",
    });
    expect(String(rows[0]?.targetTenantId)).toBe(TENANT);
    expect(String(rows[0]?.actorUserId)).toBe(ACTOR);
  });

  it("AC1 — the reverse override restores Premium's limits and clears the freeze, with every document still present", async () => {
    await overrideTenantTier(
      {
        tenantId: TENANT,
        body: { tier: "free", reason: "refund issued" },
        audit: await auditForThisCall(),
      },
      { billing: { now: () => NOW } },
    );
    const afterDowngrade = await counts();

    const result = await overrideTenantTier(
      {
        tenantId: TENANT,
        body: { tier: "premium", reason: "refund reversed — put them back" },
        audit: await auditForThisCall(),
      },
      { billing: { now: () => NOW } },
    );

    const tenant = await (await col("tenants")).findOne({ _id: tenantOid });
    expect(tenant?.tier).toBe("premium");
    expect(tenant?.limits).toEqual(TIER_LIMITS.premium);
    expect(tenant?.readOnly).toEqual([]);
    expect(tenant?.downgradedAt).toBeNull();
    expect(tenant?.billing?.graceExpiresAt ?? null).toBeNull();
    expect(result).toMatchObject({ fromTier: "free", toTier: "premium", changed: true });

    // Still nothing deleted — and the forms unpublished on the way down stay
    // unpublished on the way up (docs/TIERS.md §4: re-publishing is a choice).
    expect(await counts()).toEqual(afterDowngrade);
    const published = await (await col("forms")).countDocuments({ published: true });
    expect(published).toBe(2);
  });

  it("AC5 — a no-op override changes nothing at all, but is still audited", async () => {
    await (
      await col("tenants")
    ).updateOne(
      { _id: tenantOid },
      { $set: { tier: "free", readOnly: ["records"], downgradedAt: NOW } },
    );
    const before = await counts();

    const result = await overrideTenantTier(
      {
        tenantId: TENANT,
        body: { tier: "free", reason: "just confirming" },
        audit: await auditForThisCall(),
      },
      { billing: { now: () => NOW } },
    );

    const tenant = await (await col("tenants")).findOne({ _id: tenantOid });
    // Not re-frozen: `readOnly` is exactly what it was, not recomputed.
    expect(tenant?.readOnly).toEqual(["records"]);
    expect(tenant?.downgradedAt).toEqual(NOW);
    expect(await counts()).toEqual(before);
    expect(await (await col("forms")).countDocuments({ published: true })).toBe(5);

    expect(result).toMatchObject({ changed: false, readOnly: ["records"] });
    const rows = await (await col(ADMIN_AUDIT_COLLECTION)).find({}).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ changed: false, ok: true });
  });

  it("AC9 — an unknown but well-formed tenant id is a 404 and writes no audit row", async () => {
    await expect(
      overrideTenantTier(
        {
          tenantId: "0000000000000000000000ff",
          body: { tier: "free", reason: "nobody home" },
          audit: await auditForThisCall(),
        },
        { billing: { now: () => NOW } },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await (await col(ADMIN_AUDIT_COLLECTION)).countDocuments({})).toBe(0);
  });
});
