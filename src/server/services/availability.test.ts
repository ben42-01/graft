/**
 * The availability engine — unit coverage for the arithmetic and the
 * lifecycle (docs/BMS_EXTENSION.md §2.1).
 *
 * The overlap rule and the buffer rule are pure functions and are pinned as
 * such: they are the two places where an off-by-one is a double booking, and
 * neither needs a database to be wrong. The concurrency guarantee cannot be
 * proven here — snapshot isolation is a property of a real replica set — so it
 * lives in availability.integration.test.ts.
 */
import { ObjectId, type WithId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import type { Repository } from "@/server/repositories/base";
import {
  blockedWindow,
  confirmAllocation,
  isAvailable,
  listAllocations,
  overlapFilter,
  releaseAllocation,
  toAllocationView,
  type AvailabilityDeps,
  type ResourceAllocationDoc,
} from "./availability";
import type { InventoryPoolDoc } from "./inventory";

const TENANT = "000000000000000000000001";
const POOL_ID = "000000000000000000000041";
const RECORD_ID = "000000000000000000000051";
const ENTITY_ID = "000000000000000000000021";

const NOW = new Date("2026-06-15T09:00:00.000Z");
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

const ctx: Ctx = createContext({
  requestId: "req-availability",
  tenantId: TENANT,
  userId: "00000000000000000000000b",
  roles: ["owner"],
  tier: "free",
});

const pool = (over: Partial<InventoryPoolDoc> = {}): InventoryPoolDoc & { _id: ObjectId } => ({
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

const allocation = (
  over: Partial<ResourceAllocationDoc> = {},
): WithId<ResourceAllocationDoc> => {
  const startAt = over.startAt ?? at(1);
  const endAt = over.endAt ?? at(3);
  return {
    _id: new ObjectId(),
    tenantId: new ObjectId(TENANT),
    poolId: new ObjectId(POOL_ID),
    recordId: new ObjectId(RECORD_ID),
    holderId: null,
    startAt,
    endAt,
    ...blockedWindow(startAt, endAt, 0),
    quantity: 1,
    status: "confirmed",
    expiresAt: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
};

/**
 * A repository stand-in that actually applies `overlapFilter` rather than
 * returning whatever it was seeded with — otherwise these tests would prove
 * the arithmetic and nothing about the filter that feeds it.
 */
function fakeAllocations(seed: WithId<ResourceAllocationDoc>[] = []) {
  const docs = [...seed];
  const repo: Repository<ResourceAllocationDoc> = {
    collectionName: "resource_allocations",
    collection: vi.fn() as unknown as Repository<ResourceAllocationDoc>["collection"],

    async find(_ctx, filter) {
      const f = (filter ?? {}) as Record<string, never> & {
        poolId?: ObjectId;
        status?: { $in: string[] };
        blockedFrom?: { $lt: Date };
        blockedUntil?: { $gt: Date };
        $or?: { expiresAt: null | { $gt: Date } }[];
      };
      return docs.filter((d) => {
        if (d.deletedAt) return false;
        if (f.poolId && !d.poolId.equals(f.poolId)) return false;
        if (f.status && !f.status.$in.includes(d.status)) return false;
        if (f.blockedFrom && !(d.blockedFrom < f.blockedFrom.$lt)) return false;
        if (f.blockedUntil && !(d.blockedUntil > f.blockedUntil.$gt)) return false;
        if (f.$or) {
          const live =
            d.expiresAt === null || d.expiresAt > (f.$or[1].expiresAt as { $gt: Date }).$gt;
          if (!live) return false;
        }
        return true;
      });
    },

    async findOne() {
      return null;
    },
    async findById(_ctx, id) {
      return docs.find((d) => d._id.equals(new ObjectId(id.toString()))) ?? null;
    },
    async count() {
      return docs.length;
    },
    async insertOne() {
      throw new Error("holds go through a transaction, not the repository");
    },
    async updateOne(_ctx, filter, update) {
      const f = filter as Record<string, unknown>;
      const index = docs.findIndex((d) => {
        if (!d._id.equals(f._id as ObjectId)) return false;
        const status = f.status as string | { $in: string[] } | undefined;
        if (typeof status === "string") return d.status === status;
        if (status && "$in" in status) return status.$in.includes(d.status);
        return true;
      });
      if (index === -1) return null;
      docs[index] = { ...docs[index], ...(update.$set ?? {}) } as WithId<ResourceAllocationDoc>;
      return docs[index];
    },
    async softDelete() {
      return true;
    },
    async listPage() {
      return { items: docs, meta: { limit: 25, hasMore: false, cursor: null } };
    },
  };
  return { repo, docs };
}

const deps = (
  poolDoc: InventoryPoolDoc & { _id: ObjectId },
  seed: WithId<ResourceAllocationDoc>[] = [],
  now: Date = NOW,
): Partial<AvailabilityDeps> => ({
  allocations: fakeAllocations(seed).repo,
  findPool: async () => poolDoc,
  now: () => now,
});

describe("blockedWindow", () => {
  it("extends both ends by the buffer", () => {
    const { blockedFrom, blockedUntil } = blockedWindow(at(1), at(3), 30);
    expect(blockedFrom).toEqual(at(0.5));
    expect(blockedUntil).toEqual(at(3.5));
  });

  it("is the identity when there is no buffer", () => {
    const { blockedFrom, blockedUntil } = blockedWindow(at(1), at(3), 0);
    expect(blockedFrom).toEqual(at(1));
    expect(blockedUntil).toEqual(at(3));
  });
});

describe("overlapFilter", () => {
  it("only counts capacity-consuming statuses", () => {
    const filter = overlapFilter(new ObjectId(POOL_ID), at(1), at(2), NOW) as {
      status: { $in: string[] };
    };
    expect(filter.status.$in).toEqual(["held", "confirmed"]);
    expect(filter.status.$in).not.toContain("released");
    expect(filter.status.$in).not.toContain("cancelled");
  });

  it("compares the blocked window, not the booked one", () => {
    const filter = overlapFilter(new ObjectId(POOL_ID), at(1), at(2), NOW) as Record<
      string,
      unknown
    >;
    expect(filter).toHaveProperty("blockedFrom");
    expect(filter).toHaveProperty("blockedUntil");
    expect(filter).not.toHaveProperty("startAt");
  });
});

describe("isAvailable — individual asset", () => {
  it("is free when nothing is booked", async () => {
    const result = await isAvailable(
      ctx,
      POOL_ID,
      { startAt: at(1), endAt: at(3) },
      deps(pool()),
    );
    expect(result).toMatchObject({ available: true, capacity: 1, used: 0, remaining: 1 });
  });

  it("is taken when a confirmed booking overlaps", async () => {
    const result = await isAvailable(
      ctx,
      POOL_ID,
      { startAt: at(2), endAt: at(4) },
      deps(pool(), [allocation({ startAt: at(1), endAt: at(3) })]),
    );
    expect(result).toMatchObject({ available: false, used: 1, remaining: 0 });
  });

  it("allows a booking that starts exactly when another ends — ranges are half-open", async () => {
    const result = await isAvailable(
      ctx,
      POOL_ID,
      { startAt: at(3), endAt: at(5) },
      deps(pool(), [allocation({ startAt: at(1), endAt: at(3) })]),
    );
    expect(result.available).toBe(true);
  });

  it("ignores a released allocation — the capacity came back", async () => {
    const result = await isAvailable(
      ctx,
      POOL_ID,
      { startAt: at(1), endAt: at(3) },
      deps(pool(), [allocation({ status: "released" })]),
    );
    expect(result).toMatchObject({ available: true, used: 0 });
  });

  it("ignores a hold whose lease has lapsed", async () => {
    const lapsed = allocation({ status: "held", expiresAt: new Date(NOW.getTime() - 1) });
    const result = await isAvailable(
      ctx,
      POOL_ID,
      { startAt: at(1), endAt: at(3) },
      deps(pool(), [lapsed]),
    );
    expect(result).toMatchObject({ available: true, used: 0 });
  });

  it("respects a hold that is still live", async () => {
    const live = allocation({ status: "held", expiresAt: new Date(NOW.getTime() + 60_000) });
    const result = await isAvailable(
      ctx,
      POOL_ID,
      { startAt: at(1), endAt: at(3) },
      deps(pool(), [live]),
    );
    expect(result.available).toBe(false);
  });
});

describe("isAvailable — buffers", () => {
  it("blocks a back-to-back booking that falls inside the turnaround", async () => {
    const buffered = pool({ bufferMinutes: 30 });
    const booked = allocation({
      startAt: at(1),
      endAt: at(3),
      ...blockedWindow(at(1), at(3), 30),
    });

    // 15 minutes after the previous booking ends — inside the 30-minute clean.
    const result = await isAvailable(
      ctx,
      POOL_ID,
      { startAt: at(3.25), endAt: at(5) },
      deps(buffered, [booked]),
    );
    expect(result.available).toBe(false);
  });

  it("allows a booking that starts exactly when the turnaround ends", async () => {
    const buffered = pool({ bufferMinutes: 30 });
    const booked = allocation({
      startAt: at(1),
      endAt: at(3),
      ...blockedWindow(at(1), at(3), 30),
    });

    const result = await isAvailable(
      ctx,
      POOL_ID,
      { startAt: at(3.5), endAt: at(5) },
      deps(buffered, [booked]),
    );
    expect(result.available).toBe(true);
  });

  it("applies the buffer before an existing booking too", async () => {
    const buffered = pool({ bufferMinutes: 30 });
    const booked = allocation({
      startAt: at(3),
      endAt: at(5),
      ...blockedWindow(at(3), at(5), 30),
    });

    // Ends 15 minutes before the next booking starts — not enough turnaround.
    const result = await isAvailable(
      ctx,
      POOL_ID,
      { startAt: at(1), endAt: at(2.75) },
      deps(buffered, [booked]),
    );
    expect(result.available).toBe(false);
  });
});

describe("isAvailable — pooled quantity", () => {
  const kayaks = pool({ strategy: "pooled_quantity", totalQuantity: 50 });

  it("sums quantities rather than counting rows", async () => {
    const result = await isAvailable(
      ctx,
      POOL_ID,
      { startAt: at(1), endAt: at(3), quantity: 5 },
      deps(kayaks, [allocation({ quantity: 30 }), allocation({ quantity: 12 })]),
    );
    expect(result).toMatchObject({ available: true, used: 42, remaining: 8, requested: 5 });
  });

  it("refuses a request larger than what is left", async () => {
    const result = await isAvailable(
      ctx,
      POOL_ID,
      { startAt: at(1), endAt: at(3), quantity: 9 },
      deps(kayaks, [allocation({ quantity: 42 })]),
    );
    expect(result).toMatchObject({ available: false, remaining: 8 });
  });

  it("reports zero rather than a negative remainder on an over-committed pool", async () => {
    const result = await isAvailable(
      ctx,
      POOL_ID,
      { startAt: at(1), endAt: at(3), quantity: 1 },
      deps(kayaks, [allocation({ quantity: 60 })]),
    );
    expect(result.remaining).toBe(0);
    expect(result.used).toBe(60);
  });
});

describe("isAvailable — validation", () => {
  it("refuses a range that ends before it starts", async () => {
    await expect(
      isAvailable(ctx, POOL_ID, { startAt: at(3), endAt: at(1) }, deps(pool())),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("refuses an absurdly long range", async () => {
    await expect(
      isAvailable(
        ctx,
        POOL_ID,
        { startAt: at(0), endAt: new Date(NOW.getTime() + 400 * 86_400_000) },
        deps(pool()),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("404s for a pool this tenant cannot see", async () => {
    await expect(
      isAvailable(
        ctx,
        POOL_ID,
        { startAt: at(1), endAt: at(2) },
        {
          ...deps(pool()),
          findPool: async () => null,
        },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("confirmAllocation", () => {
  it("drops the lease so the booking can no longer lapse", async () => {
    const held = allocation({
      status: "held",
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    const view = await confirmAllocation(
      ctx,
      held._id.toHexString(),
      undefined,
      deps(pool(), [held]),
    );
    expect(view.status).toBe("confirmed");
    expect(view.expiresAt).toBeNull();
  });

  it("attaches the order the booking now belongs to", async () => {
    const held = allocation({ status: "held", expiresAt: new Date(NOW.getTime() + 60_000) });
    const orderId = "0000000000000000000000aa";
    const view = await confirmAllocation(
      ctx,
      held._id.toHexString(),
      orderId,
      deps(pool(), [held]),
    );
    expect(view.holderId).toBe(orderId);
  });

  it("refuses an expired hold — its capacity has been on sale since it lapsed", async () => {
    const lapsed = allocation({ status: "held", expiresAt: new Date(NOW.getTime() - 1) });
    await expect(
      confirmAllocation(ctx, lapsed._id.toHexString(), undefined, deps(pool(), [lapsed])),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("is idempotent for an already confirmed booking", async () => {
    const confirmed = allocation({ status: "confirmed" });
    const view = await confirmAllocation(
      ctx,
      confirmed._id.toHexString(),
      undefined,
      deps(pool(), [confirmed]),
    );
    expect(view.status).toBe("confirmed");
  });

  it("refuses to revive a released allocation", async () => {
    const released = allocation({ status: "released" });
    await expect(
      confirmAllocation(ctx, released._id.toHexString(), undefined, deps(pool(), [released])),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("releaseAllocation", () => {
  it("gives the capacity back", async () => {
    const held = allocation({ status: "held", expiresAt: new Date(NOW.getTime() + 60_000) });
    const d = deps(pool(), [held]);
    const view = await releaseAllocation(ctx, held._id.toHexString(), "released", d);
    expect(view.status).toBe("released");
    expect(view.expiresAt).toBeNull();
  });

  it("cancels a confirmed booking, which reads differently from a released hold", async () => {
    const confirmed = allocation({ status: "confirmed" });
    const view = await releaseAllocation(
      ctx,
      confirmed._id.toHexString(),
      "cancelled",
      deps(pool(), [confirmed]),
    );
    expect(view.status).toBe("cancelled");
  });

  it("is idempotent for something already released", async () => {
    const released = allocation({ status: "released" });
    const view = await releaseAllocation(
      ctx,
      released._id.toHexString(),
      "released",
      deps(pool(), [released]),
    );
    expect(view.status).toBe("released");
  });

  it("404s for an allocation this tenant cannot see", async () => {
    await expect(
      releaseAllocation(ctx, new ObjectId().toHexString(), "released", deps(pool(), [])),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("listAllocations — the master schedule's read", () => {
  it("filters on the blocked window, so buffers count as occupied time", async () => {
    const captured: Record<string, unknown>[] = [];
    const repo = fakeAllocations([allocation()]).repo;
    const spy: typeof repo = {
      ...repo,
      async listPage(_ctx, options) {
        captured.push((options?.filter ?? {}) as Record<string, unknown>);
        return { items: [allocation()], meta: { limit: 25, hasMore: false, cursor: null } };
      },
    };

    await listAllocations(
      ctx,
      { from: at(1).toISOString(), to: at(4).toISOString() },
      { allocations: spy, findPool: async () => pool(), now: () => NOW },
    );

    // The booked window would miss a booking whose *buffer* reaches into the
    // requested range — which is exactly what a scheduler must not miss.
    expect(captured[0]).toHaveProperty("blockedFrom");
    expect(captured[0]).toHaveProperty("blockedUntil");
    expect(captured[0]).not.toHaveProperty("startAt");
  });

  it("narrows to one pool when asked", async () => {
    const captured: Record<string, unknown>[] = [];
    const repo = fakeAllocations([]).repo;
    const spy: typeof repo = {
      ...repo,
      async listPage(_ctx, options) {
        captured.push((options?.filter ?? {}) as Record<string, unknown>);
        return { items: [], meta: { limit: 25, hasMore: false, cursor: null } };
      },
    };

    await listAllocations(ctx, { poolId: POOL_ID }, { allocations: spy });
    expect((captured[0].poolId as ObjectId).toHexString()).toBe(POOL_ID);
  });

  it("applies no window at all when only half a range is given", async () => {
    const captured: Record<string, unknown>[] = [];
    const repo = fakeAllocations([]).repo;
    const spy: typeof repo = {
      ...repo,
      async listPage(_ctx, options) {
        captured.push((options?.filter ?? {}) as Record<string, unknown>);
        return { items: [], meta: { limit: 25, hasMore: false, cursor: null } };
      },
    };

    // Half a range is not a range; filtering on it would silently answer a
    // different question than the one asked.
    await listAllocations(ctx, { from: at(1).toISOString() }, { allocations: spy });
    expect(captured[0]).not.toHaveProperty("blockedFrom");
  });

  it("returns views, never raw documents", async () => {
    const result = await listAllocations(
      ctx,
      {},
      { allocations: fakeAllocations([allocation()]).repo },
    );
    expect(result.items[0]).not.toHaveProperty("tenantId");
    expect(result.items[0]).toHaveProperty("poolId");
  });

  it("refuses a malformed pool id rather than querying with it", async () => {
    await expect(
      listAllocations(ctx, { poolId: "nope" }, { allocations: fakeAllocations([]).repo }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("toAllocationView", () => {
  it("exposes ids as strings and hides the tenant entirely", () => {
    const view = toAllocationView(allocation({ holderId: new ObjectId(POOL_ID) }));
    expect(view.poolId).toBe(POOL_ID);
    expect(view.holderId).toBe(POOL_ID);
    expect(view).not.toHaveProperty("tenantId");
  });

  it("reports a null holder for an allocation that belongs to no order yet", () => {
    expect(toAllocationView(allocation({ holderId: null })).holderId).toBeNull();
  });
});
