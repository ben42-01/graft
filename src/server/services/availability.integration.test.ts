/**
 * The overbooking guarantee, against a real MongoDB replica set
 * (docs/BMS_EXTENSION.md §2.1 — "Pessimistic Time-Locking", "Overbooking
 * Protection API").
 *
 * `MongoMemoryReplSet`, not `MongoMemoryServer`: holds run inside a
 * multi-document transaction, and a standalone mongod refuses
 * `session.withTransaction` outright. Same reasoning as
 * public-forms.integration.test.ts.
 *
 * This file exists for one claim that unit tests cannot make. Snapshot
 * isolation does **not** stop two concurrent transactions from both reading
 * "capacity 1, used 0" and both inserting a *different* allocation document —
 * that is write skew, and it double-books the boat. `holdResource` bumps
 * `allocationVersion` on the shared pool document inside the transaction
 * specifically to turn that into a genuine write conflict. The tests below
 * fire real concurrent holds at a real replica set, which is the only way to
 * tell a working guard from a plausible-looking one.
 */
import { ObjectId } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import { getDb, getMongoClient } from "@/server/db/mongo";
import { AppError } from "@/server/http/envelope";
import {
  confirmAllocation,
  holdResource,
  isAvailable,
  listAllocations,
  releaseAllocation,
  type ResourceAllocationDoc,
} from "./availability";
import type { InventoryPoolDoc } from "./inventory";

const TENANT_A = new ObjectId("000000000000000000000001");
const TENANT_B = new ObjectId("000000000000000000000002");
const ENTITY_ID = new ObjectId("000000000000000000000021");
const RECORD_ID = new ObjectId("000000000000000000000051");
const POOL_A = new ObjectId("000000000000000000000041");
const POOL_KAYAKS = new ObjectId("000000000000000000000042");
const POOL_B = new ObjectId("000000000000000000000043");

const NOW = new Date("2026-06-15T09:00:00.000Z");
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

const ctxFor = (tenantId: ObjectId): Ctx =>
  createContext({
    requestId: `req-${tenantId.toHexString()}`,
    tenantId: tenantId.toHexString(),
    userId: "00000000000000000000000b",
    roles: ["owner"],
    tier: "free",
  });

const ctxA = ctxFor(TENANT_A);
const ctxB = ctxFor(TENANT_B);

const poolDoc = (
  _id: ObjectId,
  tenantId: ObjectId,
  over: Partial<InventoryPoolDoc> = {},
): InventoryPoolDoc & { _id: ObjectId } => ({
  _id,
  tenantId,
  entityDefId: ENTITY_ID,
  recordId: RECORD_ID,
  strategy: "individual_asset",
  totalQuantity: 1,
  bufferMinutes: 0,
  autoLockOnCheckout: true,
  allocationVersion: 0,
  deletedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, dbName: "graft_availability" },
  });
  process.env.MONGODB_URI = replSet.getUri("graft_availability");
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  process.env.APP_ENV = "qa";

  const db = await getDb();
  // The index the availability query actually uses in production. Present here
  // so the test exercises the same plan, not a collection scan that happens to
  // agree with it.
  await db
    .collection("resource_allocations")
    .createIndex({ tenantId: 1, poolId: 1, blockedFrom: 1, blockedUntil: 1 });
}, 60_000);

afterAll(async () => {
  const client = await getMongoClient();
  await client.close();
  await replSet.stop();
});

beforeEach(async () => {
  const db = await getDb();
  await Promise.all(
    ["inventory_pools", "resource_allocations"].map((name) =>
      db.collection(name).deleteMany({}),
    ),
  );
  await db.collection<InventoryPoolDoc>("inventory_pools").insertMany([
    poolDoc(POOL_A, TENANT_A),
    poolDoc(POOL_KAYAKS, TENANT_A, {
      strategy: "pooled_quantity",
      totalQuantity: 3,
      recordId: new ObjectId("000000000000000000000052"),
    }),
    poolDoc(POOL_B, TENANT_B),
  ]);
});

const window = { startAt: at(1), endAt: at(3) };

/** Settled results, so a rejected hold is data rather than a failed test. */
async function settle<T>(promises: Promise<T>[]) {
  const results = await Promise.allSettled(promises);
  return {
    fulfilled: results.filter((r) => r.status === "fulfilled"),
    rejected: results.filter((r) => r.status === "rejected").map((r) => r.reason),
  };
}

describe("holdResource — the pessimistic time-lock", () => {
  it("takes a hold with a lease when the resource is free", async () => {
    const held = await holdResource(ctxA, POOL_A.toHexString(), window);

    expect(held.status).toBe("held");
    expect(held.expiresAt).toBeInstanceOf(Date);
    expect(held.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(held.quantity).toBe(1);
  });

  it("blocks a second hold on the same window", async () => {
    await holdResource(ctxA, POOL_A.toHexString(), window);

    await expect(holdResource(ctxA, POOL_A.toHexString(), window)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("allows an adjacent hold — ranges are half-open", async () => {
    await holdResource(ctxA, POOL_A.toHexString(), window);
    const next = await holdResource(ctxA, POOL_A.toHexString(), {
      startAt: at(3),
      endAt: at(5),
    });
    expect(next.status).toBe("held");
  });

  it("bumps allocationVersion, which is what serialises concurrent holds", async () => {
    await holdResource(ctxA, POOL_A.toHexString(), window);
    const db = await getDb();
    const pool = await db
      .collection<InventoryPoolDoc>("inventory_pools")
      .findOne({ _id: POOL_A });
    expect(pool?.allocationVersion).toBeGreaterThan(0);
  });

  it("refuses a pool that does not take checkout holds", async () => {
    const db = await getDb();
    await db
      .collection<InventoryPoolDoc>("inventory_pools")
      .updateOne({ _id: POOL_A }, { $set: { autoLockOnCheckout: false } });

    await expect(holdResource(ctxA, POOL_A.toHexString(), window)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("holdResource — concurrency (write skew)", () => {
  it("lets exactly one of eight simultaneous holds win a single asset", async () => {
    const { fulfilled, rejected } = await settle(
      Array.from({ length: 8 }, () => holdResource(ctxA, POOL_A.toHexString(), window)),
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    for (const error of rejected) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("CONFLICT");
    }

    // The database, not the return values, is the thing being trusted here.
    const db = await getDb();
    const live = await db
      .collection<ResourceAllocationDoc>("resource_allocations")
      .countDocuments({ poolId: POOL_A, status: { $in: ["held", "confirmed"] } });
    expect(live).toBe(1);
  });

  it("lets exactly three of twelve simultaneous holds fit a capacity of three", async () => {
    const { fulfilled, rejected } = await settle(
      Array.from({ length: 12 }, () => holdResource(ctxA, POOL_KAYAKS.toHexString(), window)),
    );

    expect(fulfilled).toHaveLength(3);
    expect(rejected).toHaveLength(9);

    const db = await getDb();
    const rows = await db
      .collection<ResourceAllocationDoc>("resource_allocations")
      .find({ poolId: POOL_KAYAKS, status: { $in: ["held", "confirmed"] } })
      .toArray();
    expect(rows.reduce((total, row) => total + row.quantity, 0)).toBe(3);
  });

  it("never over-allocates when the requests are for different quantities", async () => {
    const { fulfilled } = await settle([
      holdResource(ctxA, POOL_KAYAKS.toHexString(), { ...window, quantity: 2 }),
      holdResource(ctxA, POOL_KAYAKS.toHexString(), { ...window, quantity: 2 }),
      holdResource(ctxA, POOL_KAYAKS.toHexString(), { ...window, quantity: 1 }),
      holdResource(ctxA, POOL_KAYAKS.toHexString(), { ...window, quantity: 3 }),
    ]);

    const db = await getDb();
    const rows = await db
      .collection<ResourceAllocationDoc>("resource_allocations")
      .find({ poolId: POOL_KAYAKS, status: { $in: ["held", "confirmed"] } })
      .toArray();
    const total = rows.reduce((sum, row) => sum + row.quantity, 0);

    expect(total).toBeLessThanOrEqual(3);
    expect(rows).toHaveLength(fulfilled.length);
  });
});

describe("holds and buffers", () => {
  it("keeps the turnaround clear of the next booking", async () => {
    const db = await getDb();
    await db
      .collection<InventoryPoolDoc>("inventory_pools")
      .updateOne({ _id: POOL_A }, { $set: { bufferMinutes: 30 } });

    await holdResource(ctxA, POOL_A.toHexString(), window);

    // 15 minutes after the booking ends — inside the 30-minute clean.
    await expect(
      holdResource(ctxA, POOL_A.toHexString(), { startAt: at(3.25), endAt: at(5) }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Exactly at the end of the turnaround — fine.
    const next = await holdResource(ctxA, POOL_A.toHexString(), {
      startAt: at(3.5),
      endAt: at(5),
    });
    expect(next.status).toBe("held");
  });

  it("stores the blocked window, buffer included", async () => {
    const db = await getDb();
    await db
      .collection<InventoryPoolDoc>("inventory_pools")
      .updateOne({ _id: POOL_A }, { $set: { bufferMinutes: 30 } });

    const held = await holdResource(ctxA, POOL_A.toHexString(), window);
    expect(held.blockedFrom).toEqual(at(0.5));
    expect(held.blockedUntil).toEqual(at(3.5));
  });
});

describe("the allocation lifecycle", () => {
  it("frees the resource when a hold is released", async () => {
    const held = await holdResource(ctxA, POOL_A.toHexString(), window);
    await releaseAllocation(ctxA, held.id, "released");

    const next = await holdResource(ctxA, POOL_A.toHexString(), window);
    expect(next.status).toBe("held");
  });

  it("keeps the resource taken once a hold is confirmed", async () => {
    const held = await holdResource(ctxA, POOL_A.toHexString(), window);
    const confirmed = await confirmAllocation(ctxA, held.id, undefined);
    expect(confirmed.expiresAt).toBeNull();

    await expect(holdResource(ctxA, POOL_A.toHexString(), window)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("frees the resource when a lease lapses, with nothing sweeping it", async () => {
    const held = await holdResource(ctxA, POOL_A.toHexString(), window);

    // Rewind the lease rather than waiting ten minutes. The row is untouched
    // otherwise, which is exactly the state an abandoned checkout leaves.
    const db = await getDb();
    await db
      .collection<ResourceAllocationDoc>("resource_allocations")
      .updateOne(
        { _id: new ObjectId(held.id) },
        { $set: { expiresAt: new Date(Date.now() - 1) } },
      );

    const availability = await isAvailable(ctxA, POOL_A.toHexString(), window);
    expect(availability.available).toBe(true);

    const next = await holdResource(ctxA, POOL_A.toHexString(), window);
    expect(next.status).toBe("held");
  });
});

describe("tenant isolation", () => {
  it("cannot hold another tenant's pool — 404, not 403", async () => {
    await expect(holdResource(ctxA, POOL_B.toHexString(), window)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("cannot read another tenant's availability", async () => {
    await expect(isAvailable(ctxA, POOL_B.toHexString(), window)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("does not see another tenant's allocations on the schedule", async () => {
    await holdResource(ctxA, POOL_A.toHexString(), window);
    await holdResource(ctxB, POOL_B.toHexString(), window);

    const mine = await listAllocations(ctxA, {});
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0].poolId).toBe(POOL_A.toHexString());
  });

  it("cannot release another tenant's allocation", async () => {
    const theirs = await holdResource(ctxB, POOL_B.toHexString(), window);
    await expect(releaseAllocation(ctxA, theirs.id, "cancelled")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("listAllocations — the master schedule", () => {
  it("filters on the blocked window, so buffers show as occupied time", async () => {
    const db = await getDb();
    await db
      .collection<InventoryPoolDoc>("inventory_pools")
      .updateOne({ _id: POOL_A }, { $set: { bufferMinutes: 60 } });
    await holdResource(ctxA, POOL_A.toHexString(), window);

    // A window that touches only the buffer, never the booking itself.
    const overlapping = await listAllocations(ctxA, { from: at(3.25), to: at(3.75) });
    expect(overlapping.items).toHaveLength(1);

    const clear = await listAllocations(ctxA, { from: at(5), to: at(6) });
    expect(clear.items).toHaveLength(0);
  });

  it("narrows to one pool", async () => {
    await holdResource(ctxA, POOL_A.toHexString(), window);
    await holdResource(ctxA, POOL_KAYAKS.toHexString(), window);

    const kayaks = await listAllocations(ctxA, { poolId: POOL_KAYAKS.toHexString() });
    expect(kayaks.items).toHaveLength(1);
    expect(kayaks.items[0].poolId).toBe(POOL_KAYAKS.toHexString());
  });
});
