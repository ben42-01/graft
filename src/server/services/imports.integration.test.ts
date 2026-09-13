/**
 * Batch record import — integration coverage against a real MongoDB
 * (GRAFT-25.1 AC7, AC8, AC11).
 *
 * The unit tests prove the decisions; these prove the two things a fake cannot:
 * that the `records` meter really does cut a file off mid-way and leave the
 * counter exact (AC8), and that a stored record a row duplicates is not
 * touched — same `updatedAt`, to the millisecond (AC7).
 *
 * mongodb-memory-server rather than the QA docker stack, for the same reason
 * as records.integration.test.ts: CI runs `npm run test:integration` before the
 * QA stack exists.
 */
import { ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import { getDb, getMongoClient } from "@/server/db/mongo";
import { TIER_FEATURES, TIER_LIMITS } from "@/server/tiers";
import type { EntityView } from "./entities";
import type { Entitlements } from "./entitlements";
import { startImport, type ImportDeps } from "./imports";
import { checkQuota, peekQuota } from "./meters";

const TENANT_A = "000000000000000000000001";
const TENANT_B = "000000000000000000000002";
const ENTITY_A = "000000000000000000000021";

const ctxFor = (tenantId: string): Ctx =>
  createContext({
    requestId: `req-${tenantId}`,
    tenantId,
    userId: "00000000000000000000000b",
    roles: ["owner"],
    tier: "premium",
  });

const ctxA = ctxFor(TENANT_A);
const ctxB = ctxFor(TENANT_B);

const entity: EntityView = {
  id: ENTITY_A,
  key: "products",
  name: "Products",
  fields: [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "sku", label: "SKU", type: "text", required: false },
  ],
  schemaVersion: 1,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

/** Premium, with the `records` limit dialled down so the boundary is cheap to reach. */
const premium = (records: number | null): Entitlements =>
  Object.freeze({
    tenantId: TENANT_A,
    tier: "premium",
    limits: { ...TIER_LIMITS.premium, records },
    features: { ...TIER_FEATURES.premium },
    readOnly: [],
    downgradedAt: null,
    billingAnchorDay: 1,
  }) as Entitlements;

/** Everything real except the entity lookup and the entitlement document. */
const deps = (text: string, entitlements: Entitlements): Partial<ImportDeps> => ({
  getEntity: async () => entity,
  entitlements: async () => entitlements,
  can: async () => entitlements.features.csv_import === true,
  readFile: async () => ({ text, contentType: "text/csv" }),
  checkQuota: (ctx, meter, amount) =>
    checkQuota(ctx, meter, amount, { entitlements: async () => entitlements }),
  peekQuota: (ctx, meter) => peekQuota(ctx, meter, { entitlements: async () => entitlements }),
});

const csvOf = (rows: string[][]) => rows.map((r) => r.join(",")).join("\n");

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ instance: { dbName: "graft_imports_it" } });
  process.env.MONGODB_URI = mongod.getUri("graft_imports_it");
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  process.env.APP_ENV = "qa";
}, 120_000);

afterAll(async () => {
  await (await getMongoClient()).close();
  await mongod?.stop();
});

const seedMeter = async (tenantId: string, count: number) => {
  const db = await getDb();
  await db.collection("usage_meters").deleteMany({ tenantId: new ObjectId(tenantId) });
  await db.collection("usage_meters").insertOne({
    tenantId: new ObjectId(tenantId),
    meter: "records",
    period: "all",
    count,
    warnedAt: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
};

const meterCount = async (tenantId: string): Promise<number> => {
  const db = await getDb();
  const doc = await db
    .collection("usage_meters")
    .findOne({ tenantId: new ObjectId(tenantId), meter: "records", period: "all" });
  return (doc?.count as number) ?? 0;
};

describe("startImport — the records ceiling (AC8)", () => {
  it("applies what fits, rejects the rest, and charges the meter for exactly what was written", async () => {
    const db = await getDb();
    await db.collection("records").deleteMany({});
    // 99,950 of a 100,000 limit — 50 rows of headroom for a 100-row file.
    await seedMeter(TENANT_A, 99_950);

    const rows: string[][] = [["name"]];
    for (let i = 1; i <= 100; i += 1) rows.push([`Row ${i}`]);

    const result = await startImport(
      ctxA,
      ENTITY_A,
      { mediaId: new ObjectId().toHexString(), format: "csv", mapping: {} },
      deps(csvOf(rows), premium(100_000)),
    );

    expect(result.total).toBe(100);
    expect(result.imported).toBe(50);
    expect(result.rejectedCount).toBe(50);
    expect(result.rejected[0]?.reason).toContain("records");
    expect(result.rejected.map((r) => r.row)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 51),
    );

    // Partial, reported — not a silent truncation and not an all-or-nothing refusal.
    const written = await db
      .collection("records")
      .countDocuments({ tenantId: new ObjectId(TENANT_A) });
    expect(written).toBe(50);
    expect(await meterCount(TENANT_A)).toBe(100_000);
  });

  it("AC5 — a dry run at the same boundary writes nothing and moves no meter", async () => {
    const db = await getDb();
    await db.collection("records").deleteMany({});
    await seedMeter(TENANT_A, 99_990);

    const rows: string[][] = [["name"]];
    for (let i = 1; i <= 100; i += 1) rows.push([`Row ${i}`]);

    const before = await db
      .collection("records")
      .countDocuments({ tenantId: new ObjectId(TENANT_A) });

    const result = await startImport(
      ctxA,
      ENTITY_A,
      { mediaId: new ObjectId().toHexString(), format: "csv", mapping: {}, dryRun: true },
      deps(csvOf(rows), premium(100_000)),
    );

    expect(result.dryRun).toBe(true);
    expect(result.imported).toBe(10);
    expect(result.rejectedCount).toBe(90);
    expect(
      await db.collection("records").countDocuments({ tenantId: new ObjectId(TENANT_A) }),
    ).toBe(before);
    expect(await meterCount(TENANT_A)).toBe(99_990);
  });

  it("AC2 — an unlimited records limit imports past 10,000 rather than refusing zero rows", async () => {
    const db = await getDb();
    await db.collection("records").deleteMany({});
    await seedMeter(TENANT_A, 0);

    const rows: string[][] = [["name"]];
    for (let i = 1; i <= 10_050; i += 1) rows.push([`Row ${i}`]);

    const result = await startImport(
      ctxA,
      ENTITY_A,
      { mediaId: new ObjectId().toHexString(), format: "csv", mapping: {} },
      deps(csvOf(rows), premium(null)),
    );

    expect(result.imported).toBe(10_050);
    expect(result.quota.remaining).toBeNull();
    expect(await meterCount(TENANT_A)).toBe(10_050);
  }, 60_000);
});

describe("startImport — an existing record is never overwritten (AC7)", () => {
  it("rejects the duplicate and leaves the stored record byte-for-byte as it was", async () => {
    const db = await getDb();
    await db.collection("records").deleteMany({});
    await seedMeter(TENANT_A, 0);

    const storedId = new ObjectId();
    const stamped = new Date("2026-02-02T02:02:02.002Z");
    await db.collection("records").insertOne({
      _id: storedId,
      tenantId: new ObjectId(TENANT_A),
      entityDefId: new ObjectId(ENTITY_A),
      schemaVersion: 1,
      data: { name: "Original", sku: "A-1" },
      deletedAt: null,
      createdAt: stamped,
      updatedAt: stamped,
    });

    const result = await startImport(
      ctxA,
      ENTITY_A,
      {
        mediaId: new ObjectId().toHexString(),
        format: "csv",
        mapping: {},
        dedupeKey: "sku",
      },
      deps(
        csvOf([
          ["name", "sku"],
          ["Replacement", "A-1"],
          ["Fresh", "B-2"],
        ]),
        premium(100_000),
      ),
    );

    expect(result.imported).toBe(1);
    expect(result.rejected).toEqual([
      { row: 1, field: "sku", reason: expect.stringContaining("already exists") },
    ]);

    const after = await db.collection("records").findOne({ _id: storedId });
    expect(after?.data).toEqual({ name: "Original", sku: "A-1" });
    expect(after?.updatedAt).toEqual(stamped);
    // Charged for the one row that was written, not for the duplicate.
    expect(await meterCount(TENANT_A)).toBe(1);
  });

  it("AC11 — another tenant's record is invisible to the dedupe check", async () => {
    const db = await getDb();
    await db.collection("records").deleteMany({});
    await seedMeter(TENANT_A, 0);
    await seedMeter(TENANT_B, 0);

    await db.collection("records").insertOne({
      tenantId: new ObjectId(TENANT_B),
      entityDefId: new ObjectId(ENTITY_A),
      schemaVersion: 1,
      data: { name: "Tenant B's", sku: "SHARED" },
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await startImport(
      ctxA,
      ENTITY_A,
      { mediaId: new ObjectId().toHexString(), format: "csv", mapping: {}, dedupeKey: "sku" },
      deps(
        csvOf([
          ["name", "sku"],
          ["Tenant A's", "SHARED"],
        ]),
        premium(100_000),
      ),
    );

    // Tenant B's row neither blocks the import nor leaks its existence.
    expect(result.imported).toBe(1);
    expect(result.rejected).toEqual([]);
    expect(
      await db.collection("records").countDocuments({ tenantId: new ObjectId(TENANT_B) }),
    ).toBe(1);
    expect(ctxB.tenantId).toBe(TENANT_B);
  });
});
