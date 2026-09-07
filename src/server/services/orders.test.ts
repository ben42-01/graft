/**
 * Orders — unit coverage for the state machine and the payment rules
 * (docs/BMS_EXTENSION.md §2.2).
 *
 * Two properties carry the most weight and are tested hardest: that the
 * transition table is the *only* authority on what moves are legal, and that
 * confirming or cancelling an order carries its allocations with it. An order
 * that says "confirmed" while the boat it booked has quietly lapsed is the
 * worst failure this subsystem can have.
 */
import { ObjectId, type WithId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import type { Repository } from "@/server/repositories/base";
import type { AllocationView } from "./availability";
import {
  ACTIVE_STATUSES,
  canTransition,
  createOrder,
  deleteOrder,
  ORDER_STATUSES,
  recordPayment,
  TRANSITIONS,
  transitionOrder,
  updateOrder,
  type OrderDeps,
  type OrderDoc,
} from "./orders";

const TENANT = "000000000000000000000001";
const ORDER_ID = "000000000000000000000071";
const ALLOC_A = "000000000000000000000061";
const ALLOC_B = "000000000000000000000062";

const NOW = new Date("2026-06-15T09:00:00.000Z");

const ctx: Ctx = createContext({
  requestId: "req-orders",
  tenantId: TENANT,
  userId: "00000000000000000000000b",
  roles: ["owner"],
  tier: "free",
});

const allocationView = (id: string): AllocationView => ({
  id,
  poolId: "000000000000000000000041",
  recordId: "000000000000000000000051",
  holderId: ORDER_ID,
  startAt: NOW,
  endAt: NOW,
  blockedFrom: NOW,
  blockedUntil: NOW,
  quantity: 1,
  status: "confirmed",
  expiresAt: null,
});

const seedOrder = (over: Partial<WithId<OrderDoc>> = {}): WithId<OrderDoc> => ({
  _id: new ObjectId(ORDER_ID),
  tenantId: new ObjectId(TENANT),
  customerRecordId: null,
  status: "draft",
  currency: "EUR",
  lineItems: [
    {
      kind: "resource",
      description: "24ft Pontoon Boat — 4 hours",
      quantity: 1,
      unitAmountMinor: 60_000,
      amountMinor: 60_000,
    },
  ],
  subtotalMinor: 60_000,
  discountMinor: 0,
  totalMinor: 60_000,
  depositMinor: 0,
  amountPaidMinor: 0,
  payments: [],
  allocationIds: [],
  notes: null,
  confirmedAt: null,
  completedAt: null,
  cancelledAt: null,
  deletedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

function fakeRepo(seed: WithId<OrderDoc>[] = []) {
  const docs = new Map(seed.map((d) => [d._id.toHexString(), d]));
  const tenantId = new ObjectId(TENANT);

  const repo: Repository<OrderDoc> = {
    collectionName: "orders",
    collection: vi.fn() as unknown as Repository<OrderDoc>["collection"],
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
      const withId = {
        ...doc,
        tenantId,
        createdAt: NOW,
        updatedAt: NOW,
        _id: new ObjectId(),
      } as unknown as WithId<OrderDoc>;
      docs.set(withId._id.toHexString(), withId);
      return withId;
    },
    async updateOne(_ctx, filter, update) {
      const f = filter as Record<string, unknown>;
      const target = docs.get((f._id as ObjectId).toHexString());
      if (!target) return null;
      // The status guard is what makes a double-submit safe; honouring it here
      // is the difference between testing the service and testing a stub.
      if (f.status !== undefined && target.status !== f.status) return null;

      const set = (update.$set ?? {}) as Partial<OrderDoc>;
      const inc = (update as { $inc?: Record<string, number> }).$inc ?? {};
      const push = (update as { $push?: Record<string, unknown> }).$push ?? {};

      let next = { ...target, ...set } as WithId<OrderDoc>;
      if (inc.amountPaidMinor) {
        next = { ...next, amountPaidMinor: next.amountPaidMinor + inc.amountPaidMinor };
      }
      if (push.payments) {
        next = { ...next, payments: [...next.payments, push.payments as never] };
      }
      docs.set(next._id.toHexString(), next);
      return next;
    },
    async softDelete(_ctx, id) {
      const target = docs.get(id.toString());
      if (!target) return false;
      docs.set(id.toString(), { ...target, deletedAt: NOW });
      return true;
    },
    async listPage() {
      return { items: [...docs.values()], meta: { limit: 25, hasMore: false, cursor: null } };
    },
  };
  return { repo, docs };
}

function deps(seed: WithId<OrderDoc>[] = [], over: Partial<OrderDeps> = {}) {
  const confirmed: string[] = [];
  const released: string[] = [];
  const built: Partial<OrderDeps> = {
    repo: fakeRepo(seed).repo,
    confirmAllocation: vi.fn(async (_c, id) => {
      confirmed.push(id);
      return allocationView(id);
    }),
    releaseAllocation: vi.fn(async (_c, id) => {
      released.push(id);
      return { ...allocationView(id), status: "cancelled" as const };
    }),
    now: () => NOW,
    ...over,
  };
  return { deps: built, confirmed, released };
}

describe("the transition table", () => {
  it("covers every status exactly once", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it("matches the lifecycle docs/BMS_EXTENSION.md §2.2 specifies", () => {
    expect(canTransition("draft", "pending_payment")).toBe(true);
    expect(canTransition("pending_payment", "confirmed")).toBe(true);
    expect(canTransition("confirmed", "in_progress")).toBe(true);
    expect(canTransition("in_progress", "completed")).toBe(true);
  });

  it("lets anything unfinished be cancelled", () => {
    for (const status of ACTIVE_STATUSES) {
      expect(canTransition(status, "cancelled")).toBe(true);
    }
  });

  it("has no way out of a terminal state", () => {
    expect(TRANSITIONS.completed).toEqual([]);
    expect(TRANSITIONS.cancelled).toEqual([]);
    for (const status of ORDER_STATUSES) {
      expect(canTransition("completed", status)).toBe(false);
      expect(canTransition("cancelled", status)).toBe(false);
    }
  });

  it("does not allow going backwards", () => {
    expect(canTransition("confirmed", "draft")).toBe(false);
    expect(canTransition("in_progress", "pending_payment")).toBe(false);
  });
});

describe("createOrder", () => {
  it("prices the line items once and starts as a draft", async () => {
    const { deps: d } = deps();
    const order = await createOrder(
      ctx,
      {
        currency: "EUR",
        lineItems: [
          {
            kind: "resource",
            description: "Boat — 4 hours",
            quantity: 1,
            unitAmountMinor: 60_000,
          },
          { kind: "addon", description: "Life jackets", quantity: 4, unitAmountMinor: 500 },
        ],
      },
      d,
    );

    expect(order.status).toBe("draft");
    expect(order.subtotalMinor).toBe(62_000);
    expect(order.totalMinor).toBe(62_000);
    expect(order.balanceMinor).toBe(62_000);
    expect(order.lineItems[1].amountMinor).toBe(2_000);
  });

  it("derives the deposit from the total", async () => {
    const { deps: d } = deps();
    const order = await createOrder(
      ctx,
      {
        currency: "EUR",
        lineItems: [
          { kind: "resource", description: "Boat", quantity: 1, unitAmountMinor: 60_000 },
        ],
        deposit: { percent: 30 },
      },
      d,
    );
    expect(order.depositMinor).toBe(18_000);
  });

  it("refuses an order with no line items", async () => {
    const { deps: d } = deps();
    await expect(createOrder(ctx, { currency: "EUR", lineItems: [] }, d)).rejects.toMatchObject(
      { code: "VALIDATION_FAILED" },
    );
  });

  it("refuses a currency that is not ISO 4217", async () => {
    const { deps: d } = deps();
    await expect(
      createOrder(
        ctx,
        {
          currency: "EURO",
          lineItems: [{ kind: "fee", description: "x", quantity: 1, unitAmountMinor: 1 }],
        },
        d,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("updateOrder", () => {
  it("re-prices a draft and re-derives its deposit", async () => {
    const { deps: d } = deps([seedOrder({ depositMinor: 18_000 })]);
    const order = await updateOrder(
      ctx,
      ORDER_ID,
      {
        lineItems: [
          {
            kind: "resource",
            description: "Boat — 2 hours",
            quantity: 1,
            unitAmountMinor: 30_000,
          },
        ],
        deposit: { percent: 50 },
      },
      d,
    );
    expect(order.totalMinor).toBe(30_000);
    expect(order.depositMinor).toBe(15_000);
  });

  it("clamps a stale deposit that now exceeds a smaller total", async () => {
    const { deps: d } = deps([seedOrder({ depositMinor: 50_000 })]);
    const order = await updateOrder(
      ctx,
      ORDER_ID,
      {
        lineItems: [{ kind: "fee", description: "Small", quantity: 1, unitAmountMinor: 1_000 }],
      },
      d,
    );
    expect(order.depositMinor).toBe(1_000);
  });

  it("refuses to edit an order the customer has already been asked to pay", async () => {
    const { deps: d } = deps([seedOrder({ status: "pending_payment" })]);
    await expect(updateOrder(ctx, ORDER_ID, { notes: "too late" }, d)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("transitionOrder", () => {
  it("refuses an illegal move and says what is allowed instead", async () => {
    const { deps: d } = deps([seedOrder({ status: "completed" })]);
    await expect(transitionOrder(ctx, ORDER_ID, { status: "draft" }, d)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("is idempotent for a move to the state it is already in", async () => {
    const { deps: d } = deps([seedOrder({ status: "confirmed" })]);
    const order = await transitionOrder(ctx, ORDER_ID, { status: "confirmed" }, d);
    expect(order.status).toBe("confirmed");
  });

  it("confirms every allocation the order holds, naming the order as holder", async () => {
    const { deps: d, confirmed } = deps([
      seedOrder({ allocationIds: [new ObjectId(ALLOC_A), new ObjectId(ALLOC_B)] }),
    ]);
    const order = await transitionOrder(ctx, ORDER_ID, { status: "confirmed" }, d);

    expect(confirmed).toEqual([ALLOC_A, ALLOC_B]);
    expect(d.confirmAllocation).toHaveBeenCalledWith(ctx, ALLOC_A, ORDER_ID);
    expect(order.confirmedAt).toEqual(NOW);
  });

  it("does not confirm the order when an allocation has lapsed", async () => {
    // The whole point: capacity is gone, so the order must not claim it.
    const { deps: d } = deps([seedOrder({ allocationIds: [new ObjectId(ALLOC_A)] })], {
      confirmAllocation: vi.fn(async () => {
        throw new AppError("CONFLICT", "That hold has expired.");
      }),
    });

    await expect(
      transitionOrder(ctx, ORDER_ID, { status: "confirmed" }, d),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const { getOrder } = await import("./orders");
    const after = await getOrder(ctx, ORDER_ID, d);
    expect(after.status).toBe("draft");
  });

  it("releases every allocation when the order is cancelled", async () => {
    const { deps: d, released } = deps([
      seedOrder({
        status: "confirmed",
        allocationIds: [new ObjectId(ALLOC_A), new ObjectId(ALLOC_B)],
      }),
    ]);
    const order = await transitionOrder(ctx, ORDER_ID, { status: "cancelled" }, d);

    expect(released).toEqual([ALLOC_A, ALLOC_B]);
    expect(order.status).toBe("cancelled");
    expect(order.cancelledAt).toEqual(NOW);
  });

  it("still cancels when an allocation was already released elsewhere", async () => {
    const { deps: d } = deps(
      [seedOrder({ status: "confirmed", allocationIds: [new ObjectId(ALLOC_A)] })],
      {
        releaseAllocation: vi.fn(async () => {
          throw new AppError("NOT_FOUND", "Allocation not found");
        }),
      },
    );
    const order = await transitionOrder(ctx, ORDER_ID, { status: "cancelled" }, d);
    expect(order.status).toBe("cancelled");
  });

  it("404s for another tenant's order", async () => {
    const { deps: d } = deps([]);
    await expect(
      transitionOrder(ctx, ORDER_ID, { status: "cancelled" }, d),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("recordPayment", () => {
  it("adds to a running total rather than replacing it", async () => {
    const { deps: d } = deps([seedOrder({ status: "pending_payment", depositMinor: 60_000 })]);
    await recordPayment(ctx, ORDER_ID, { amountMinor: 10_000 }, d);
    const order = await recordPayment(ctx, ORDER_ID, { amountMinor: 15_000 }, d);

    expect(order.amountPaidMinor).toBe(25_000);
    expect(order.payments).toHaveLength(2);
    expect(order.balanceMinor).toBe(35_000);
  });

  it("confirms the order once the deposit is covered, not before", async () => {
    const { deps: d } = deps([seedOrder({ status: "pending_payment", depositMinor: 18_000 })]);

    const partial = await recordPayment(ctx, ORDER_ID, { amountMinor: 10_000 }, d);
    expect(partial.status).toBe("pending_payment");

    const covered = await recordPayment(ctx, ORDER_ID, { amountMinor: 8_000 }, d);
    expect(covered.status).toBe("confirmed");
    expect(covered.balanceMinor).toBe(42_000);
  });

  it("needs the whole total when there is no deposit", async () => {
    const { deps: d } = deps([seedOrder({ status: "pending_payment", depositMinor: 0 })]);

    const partial = await recordPayment(ctx, ORDER_ID, { amountMinor: 59_999 }, d);
    expect(partial.status).toBe("pending_payment");

    const paid = await recordPayment(ctx, ORDER_ID, { amountMinor: 1 }, d);
    expect(paid.status).toBe("confirmed");
  });

  it("keeps the provider's reference against the payment", async () => {
    const { deps: d } = deps([seedOrder({ status: "pending_payment", depositMinor: 60_000 })]);
    const order = await recordPayment(
      ctx,
      ORDER_ID,
      { amountMinor: 1_000, reference: "pi_test_123" },
      d,
    );
    expect(order.payments[0].reference).toBe("pi_test_123");
    expect(order.payments[0].at).toEqual(NOW);
  });

  it("refuses a payment against a cancelled order", async () => {
    const { deps: d } = deps([seedOrder({ status: "cancelled" })]);
    await expect(recordPayment(ctx, ORDER_ID, { amountMinor: 1_000 }, d)).rejects.toMatchObject(
      { code: "CONFLICT" },
    );
  });

  it("refuses a zero or negative payment", async () => {
    const { deps: d } = deps([seedOrder()]);
    await expect(recordPayment(ctx, ORDER_ID, { amountMinor: 0 }, d)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});

describe("deleteOrder", () => {
  it("cancels first, so the allocations are released before the row goes", async () => {
    const { deps: d, released } = deps([
      seedOrder({ status: "confirmed", allocationIds: [new ObjectId(ALLOC_A)] }),
    ]);
    await deleteOrder(ctx, ORDER_ID, d);
    expect(released).toEqual([ALLOC_A]);
  });

  it("still soft-deletes an order that was already terminal", async () => {
    const { deps: d, released } = deps([seedOrder({ status: "completed" })]);
    await deleteOrder(ctx, ORDER_ID, d);
    expect(released).toEqual([]);
  });
});
