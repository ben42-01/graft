/**
 * Inventory pools — unit coverage (docs/BMS_EXTENSION.md §2.1, Step 1).
 *
 * The decisions worth pinning are the ones a later edit would find tempting to
 * "simplify": that an individual asset is normalised to a quantity of one
 * rather than being asked for, that `entityDefId` comes from the record rather
 * than the request, and that `strategy` is immutable.
 */
import { MongoServerError, ObjectId, type WithId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import type { Repository } from "@/server/repositories/base";
import type { RecordView } from "@/server/services/records";
import {
  createPool,
  deletePool,
  findPoolDoc,
  getPool,
  listPools,
  INVENTORY_STRATEGIES,
  MAX_BUFFER_MINUTES,
  quantityFor,
  toPoolView,
  updatePool,
  type InventoryDeps,
  type InventoryPoolDoc,
} from "./inventory";

const TENANT = "000000000000000000000001";
const ENTITY_ID = "000000000000000000000021";
const OTHER_ENTITY_ID = "000000000000000000000022";
const RECORD_ID = "000000000000000000000051";
const POOL_ID = "000000000000000000000041";

const NOW = new Date("2026-06-15T09:00:00.000Z");

const ctx: Ctx = createContext({
  requestId: "req-inventory",
  tenantId: TENANT,
  userId: "00000000000000000000000b",
  roles: ["owner"],
  tier: "free",
});

const record = (over: Partial<RecordView> = {}): RecordView => ({
  id: RECORD_ID,
  entityId: ENTITY_ID,
  schemaVersion: 1,
  data: { name: "24ft Pontoon Boat" },
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const seedPool = (over: Partial<WithId<InventoryPoolDoc>> = {}): WithId<InventoryPoolDoc> => ({
  _id: new ObjectId(POOL_ID),
  tenantId: new ObjectId(TENANT),
  entityDefId: new ObjectId(ENTITY_ID),
  recordId: new ObjectId(RECORD_ID),
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

/** In-memory stand-in for the repository port (base.ts). */
function fakeRepo(seed: WithId<InventoryPoolDoc>[] = []) {
  const docs = new Map(seed.map((d) => [d._id.toHexString(), d]));
  const tenantId = new ObjectId(TENANT);

  const repo: Repository<InventoryPoolDoc> = {
    collectionName: "inventory_pools",
    collection: vi.fn() as unknown as Repository<InventoryPoolDoc>["collection"],
    async find() {
      return [...docs.values()];
    },
    async findOne() {
      return null;
    },
    async findById(_ctx, id) {
      const found = docs.get(id.toString());
      return found && found.tenantId.equals(tenantId) && !found.deletedAt ? found : null;
    },
    async count() {
      return docs.size;
    },
    async insertOne(_ctx, doc) {
      const clash = [...docs.values()].find((d) => d.recordId.equals(doc.recordId));
      if (clash) throw new MongoServerError({ message: "E11000 duplicate key", code: 11000 });
      const withId = {
        ...doc,
        tenantId,
        createdAt: NOW,
        updatedAt: NOW,
        _id: new ObjectId(),
      } as unknown as WithId<InventoryPoolDoc>;
      docs.set(withId._id.toHexString(), withId);
      return withId;
    },
    async updateOne(_ctx, filter, update) {
      const target = docs.get((filter as { _id: ObjectId })._id.toHexString());
      if (!target) return null;
      const updated = { ...target, ...(update.$set ?? {}) } as WithId<InventoryPoolDoc>;
      docs.set(updated._id.toHexString(), updated);
      return updated;
    },
    async softDelete(_ctx, id) {
      const target = docs.get(id.toString());
      if (!target) return false;
      docs.set(id.toString(), { ...target, deletedAt: NOW });
      return true;
    },
    async listPage() {
      return {
        items: [...docs.values()],
        meta: { limit: 25, hasMore: false, cursor: null },
      };
    },
  };
  return { repo, docs };
}

const deps = (
  seed: WithId<InventoryPoolDoc>[] = [],
  over: Partial<InventoryDeps> = {},
): Partial<InventoryDeps> => ({
  repo: fakeRepo(seed).repo,
  getRecord: async () => record(),
  ...over,
});

describe("quantityFor", () => {
  it("forces an individual asset to exactly one, whatever was asked for", () => {
    expect(quantityFor("individual_asset")).toBe(1);
    expect(quantityFor("individual_asset", 7)).toBe(1);
  });

  it("requires a quantity for the strategies where it is the whole point", () => {
    for (const strategy of ["pooled_quantity", "time_slot"] as const) {
      expect(() => quantityFor(strategy)).toThrow();
      expect(quantityFor(strategy, 50)).toBe(50);
    }
  });
});

describe("createPool", () => {
  it("takes entityDefId from the record, never from the request", async () => {
    const { repo, docs } = fakeRepo();
    await createPool(
      ctx,
      {
        // A client claiming a different entity is simply ignored: the record
        // lookup is what decides, and a mismatched pair would have 404'd.
        entityId: OTHER_ENTITY_ID,
        recordId: RECORD_ID,
        strategy: "individual_asset",
      },
      { repo, getRecord: async () => record({ entityId: ENTITY_ID }) },
    );

    const created = [...docs.values()][0];
    expect(created.entityDefId.toHexString()).toBe(ENTITY_ID);
  });

  it("defaults to no buffer and to taking checkout holds", async () => {
    const pool = await createPool(
      ctx,
      { entityId: ENTITY_ID, recordId: RECORD_ID, strategy: "individual_asset" },
      deps(),
    );
    expect(pool.bufferMinutes).toBe(0);
    expect(pool.autoLockOnCheckout).toBe(true);
    expect(pool.totalQuantity).toBe(1);
  });

  it("carries a pooled capacity through", async () => {
    const pool = await createPool(
      ctx,
      {
        entityId: ENTITY_ID,
        recordId: RECORD_ID,
        strategy: "pooled_quantity",
        totalQuantity: 50,
        bufferMinutes: 30,
      },
      deps(),
    );
    expect(pool).toMatchObject({
      strategy: "pooled_quantity",
      totalQuantity: 50,
      bufferMinutes: 30,
    });
  });

  it("refuses a pooled strategy with no capacity", async () => {
    await expect(
      createPool(
        ctx,
        { entityId: ENTITY_ID, recordId: RECORD_ID, strategy: "pooled_quantity" },
        deps(),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("refuses a second pool on the same record", async () => {
    await expect(
      createPool(
        ctx,
        { entityId: ENTITY_ID, recordId: RECORD_ID, strategy: "individual_asset" },
        deps([seedPool()]),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a buffer beyond the cap", async () => {
    await expect(
      createPool(
        ctx,
        {
          entityId: ENTITY_ID,
          recordId: RECORD_ID,
          strategy: "individual_asset",
          bufferMinutes: MAX_BUFFER_MINUTES + 1,
        },
        deps(),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("accepts every declared strategy", async () => {
    for (const strategy of INVENTORY_STRATEGIES) {
      const pool = await createPool(
        ctx,
        { entityId: ENTITY_ID, recordId: RECORD_ID, strategy, totalQuantity: 5 },
        deps(),
      );
      expect(pool.strategy).toBe(strategy);
    }
  });

  it("propagates a record that does not exist for this tenant", async () => {
    await expect(
      createPool(
        ctx,
        { entityId: ENTITY_ID, recordId: RECORD_ID, strategy: "individual_asset" },
        deps([], {
          getRecord: async () => {
            throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("updatePool", () => {
  it("changes capacity and buffer", async () => {
    const pool = await updatePool(
      ctx,
      POOL_ID,
      { totalQuantity: 80, bufferMinutes: 15 },
      deps([seedPool({ strategy: "pooled_quantity", totalQuantity: 50 })]),
    );
    expect(pool).toMatchObject({ totalQuantity: 80, bufferMinutes: 15 });
  });

  it("refuses to give an individually tracked asset a capacity", async () => {
    await expect(
      updatePool(ctx, POOL_ID, { totalQuantity: 4 }, deps([seedPool()])),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("has no way to change the strategy", async () => {
    // `strategy` is not a key of updatePoolSchema, so Zod strips it and the
    // "nothing to update" refinement is what rejects the request. That is the
    // behaviour worth pinning: a caller cannot reinterpret every allocation
    // already written against this pool, and cannot do it *silently* either.
    await expect(
      updatePool(ctx, POOL_ID, { strategy: "pooled_quantity" }, deps([seedPool()])),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("404s for another tenant's pool", async () => {
    await expect(
      updatePool(ctx, POOL_ID, { bufferMinutes: 5 }, deps([])),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("getPool / deletePool", () => {
  it("reads a pool back", async () => {
    const pool = await getPool(ctx, POOL_ID, deps([seedPool()]));
    expect(pool.recordId).toBe(RECORD_ID);
  });

  it("404s for a pool this tenant cannot see", async () => {
    await expect(getPool(ctx, POOL_ID, deps([]))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("soft-deletes, leaving allocations alone as the record of what happened", async () => {
    const { repo, docs } = fakeRepo([seedPool()]);
    await deletePool(ctx, POOL_ID, { repo, getRecord: async () => record() });
    expect(docs.get(POOL_ID)?.deletedAt).toEqual(NOW);
  });
});

describe("listPools", () => {
  it("returns views, never raw documents", async () => {
    const result = await listPools(ctx, {}, deps([seedPool()]));
    expect(result.items[0]).not.toHaveProperty("tenantId");
    expect(result.items[0]).toMatchObject({
      recordId: RECORD_ID,
      strategy: "individual_asset",
    });
  });

  it("narrows to one entity type — the scheduler's main query", async () => {
    const captured: Record<string, unknown>[] = [];
    const base = fakeRepo([seedPool()]).repo;
    const spy: typeof base = {
      ...base,
      async listPage(_ctx, options) {
        captured.push((options?.filter ?? {}) as Record<string, unknown>);
        return { items: [seedPool()], meta: { limit: 25, hasMore: false, cursor: null } };
      },
    };

    await listPools(
      ctx,
      { entityId: ENTITY_ID },
      { repo: spy, getRecord: async () => record() },
    );
    expect((captured[0].entityDefId as ObjectId).toHexString()).toBe(ENTITY_ID);
  });

  it("applies no filter when no entity is named", async () => {
    const captured: (Record<string, unknown> | undefined)[] = [];
    const base = fakeRepo([]).repo;
    const spy: typeof base = {
      ...base,
      async listPage(_ctx, options) {
        captured.push(options?.filter as Record<string, unknown> | undefined);
        return { items: [], meta: { limit: 25, hasMore: false, cursor: null } };
      },
    };

    await listPools(ctx, {}, { repo: spy, getRecord: async () => record() });
    expect(captured[0]).toBeUndefined();
  });
});

describe("findPoolDoc", () => {
  it("hands the engine the document, not a view", async () => {
    const doc = await findPoolDoc(ctx, POOL_ID, deps([seedPool()]));
    // availability.ts needs `tenantId` and `_id`, which a view deliberately drops.
    expect(doc?.tenantId).toBeInstanceOf(ObjectId);
    expect(doc?.allocationVersion).toBe(0);
  });

  it("returns null for a malformed id rather than throwing", async () => {
    expect(await findPoolDoc(ctx, "not-an-id", deps([]))).toBeNull();
  });

  it("returns null for another tenant's pool", async () => {
    expect(await findPoolDoc(ctx, POOL_ID, deps([]))).toBeNull();
  });
});

describe("toPoolView", () => {
  it("exposes ids as strings and hides the tenant", () => {
    const view = toPoolView(seedPool());
    expect(view).toMatchObject({ id: POOL_ID, entityId: ENTITY_ID, recordId: RECORD_ID });
    expect(view).not.toHaveProperty("tenantId");
    // `allocationVersion` is an internal concurrency guard, not an API field.
    expect(view).not.toHaveProperty("allocationVersion");
  });
});

describe("deletePool", () => {
  it("404s for a pool this tenant cannot see", async () => {
    await expect(deletePool(ctx, POOL_ID, deps([]))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
