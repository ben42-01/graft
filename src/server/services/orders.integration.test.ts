/**
 * Orders and invoicing against a real MongoDB replica set
 * (docs/BMS_EXTENSION.md §2.2, Step 3).
 *
 * `MongoMemoryReplSet` because the flow reaches `holdResource`, which runs in a
 * transaction — same reasoning as availability.integration.test.ts.
 *
 * Two claims here cannot be made against fakes:
 *
 *   1. **Invoice numbers are sequential and gapless under concurrency.** The
 *      counter is an atomic `$inc` with an upsert; a fake that returns
 *      `++seq` proves the format, not the race. An auditor's question about a
 *      missing number deserves a real answer.
 *   2. **A confirmed order really holds its capacity.** The order service and
 *      the availability engine are separate modules with separate stores, and
 *      the only place their agreement can be observed is a database that has
 *      both.
 */
import { ObjectId } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import { getDb, getMongoClient } from "@/server/db/mongo";
import { holdResource, isAvailable } from "./availability";
import type { InventoryPoolDoc } from "./inventory";
import { issueInvoice, ledgerForOrder, listInvoices } from "./invoices";
import { createOrder, getOrder, recordPayment, transitionOrder } from "./orders";
import { resourceLineItem } from "./pricing";

const TENANT_A = new ObjectId("000000000000000000000001");
const TENANT_B = new ObjectId("000000000000000000000002");
const ENTITY_ID = new ObjectId("000000000000000000000021");
const RECORD_ID = new ObjectId("000000000000000000000051");
const POOL_A = new ObjectId("000000000000000000000041");

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

const BOAT = { name: "24ft Pontoon Boat", data: { hourly_rate: 150 } };

/** The §3.2 worked example: a 4-hour hire of a €150/hour boat = €600.00. */
const boatLine = () =>
  resourceLineItem({
    ...BOAT,
    basis: "hourly" as const,
    startAt: at(1),
    endAt: at(5),
    recordId: RECORD_ID.toHexString(),
  });

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, dbName: "graft_orders" },
  });
  process.env.MONGODB_URI = replSet.getUri("graft_orders");
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  process.env.APP_ENV = "qa";

  const db = await getDb();
  // The index that makes the numbering claim meaningful: without it the
  // uniqueness would rest entirely on the counter, which is the thing under
  // test.
  await db.collection("invoices").createIndex({ tenantId: 1, number: 1 }, { unique: true });
  await db
    .collection("invoice_counters")
    .createIndex({ tenantId: 1, year: 1 }, { unique: true });
}, 60_000);

afterAll(async () => {
  const client = await getMongoClient();
  await client.close();
  await replSet.stop();
});

beforeEach(async () => {
  const db = await getDb();
  await Promise.all(
    ["inventory_pools", "resource_allocations", "orders", "invoices", "invoice_counters"].map(
      (name) => db.collection(name).deleteMany({}),
    ),
  );
  await db.collection<InventoryPoolDoc>("inventory_pools").insertOne({
    _id: POOL_A,
    tenantId: TENANT_A,
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
  } as InventoryPoolDoc & { _id: ObjectId });
});

describe("the booking-to-payment flow", () => {
  it("holds capacity, prices it, takes a deposit and confirms both together", async () => {
    // 1. A checkout locks the boat.
    const held = await holdResource(ctxA, POOL_A.toHexString(), {
      startAt: at(1),
      endAt: at(5),
    });
    expect(held.status).toBe("held");

    // 2. The order is drafted from that hold, with a 30% deposit.
    const order = await createOrder(ctxA, {
      currency: "EUR",
      allocationIds: [held.id],
      lineItems: [boatLine()],
      deposit: { percent: 30 },
    });
    expect(order.totalMinor).toBe(60_000);
    expect(order.depositMinor).toBe(18_000);

    // 3. Awaiting payment.
    const pending = await transitionOrder(ctxA, order.id, { status: "pending_payment" });
    expect(pending.status).toBe("pending_payment");

    // 4. The deposit arrives, which is what confirms the order.
    const confirmed = await recordPayment(ctxA, order.id, {
      amountMinor: 18_000,
      reference: "pi_test_deposit",
    });
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.balanceMinor).toBe(42_000);

    // 5. The allocation moved with it: no lease left to lapse.
    const db = await getDb();
    const allocation = await db
      .collection("resource_allocations")
      .findOne({ _id: new ObjectId(held.id) });
    expect(allocation?.status).toBe("confirmed");
    expect(allocation?.expiresAt).toBeNull();
    expect(allocation?.holderId?.toHexString()).toBe(order.id);

    // 6. And the boat is genuinely off the market.
    const availability = await isAvailable(ctxA, POOL_A.toHexString(), {
      startAt: at(2),
      endAt: at(4),
    });
    expect(availability.available).toBe(false);
  });

  it("gives the capacity back when the order is cancelled", async () => {
    const held = await holdResource(ctxA, POOL_A.toHexString(), {
      startAt: at(1),
      endAt: at(5),
    });
    const order = await createOrder(ctxA, {
      currency: "EUR",
      allocationIds: [held.id],
      lineItems: [boatLine()],
    });
    await transitionOrder(ctxA, order.id, { status: "confirmed" });

    await transitionOrder(ctxA, order.id, { status: "cancelled" });

    const availability = await isAvailable(ctxA, POOL_A.toHexString(), {
      startAt: at(1),
      endAt: at(5),
    });
    expect(availability.available).toBe(true);
  });

  it("refuses to confirm an order whose hold lapsed while the customer paid", async () => {
    const held = await holdResource(ctxA, POOL_A.toHexString(), {
      startAt: at(1),
      endAt: at(5),
    });
    const order = await createOrder(ctxA, {
      currency: "EUR",
      allocationIds: [held.id],
      lineItems: [boatLine()],
    });

    // Rewind the lease: the checkout took too long.
    const db = await getDb();
    await db
      .collection("resource_allocations")
      .updateOne(
        { _id: new ObjectId(held.id) },
        { $set: { expiresAt: new Date(Date.now() - 1) } },
      );

    await expect(
      transitionOrder(ctxA, order.id, { status: "confirmed" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // The order must not claim a resource it no longer holds.
    const after = await getOrder(ctxA, order.id);
    expect(after.status).toBe("draft");
  });
});

describe("invoice numbering", () => {
  const draftOrder = () =>
    createOrder(ctxA, { currency: "EUR", lineItems: [boatLine()], deposit: { percent: 30 } });

  it("numbers sequentially from one, per tenant per year", async () => {
    const first = await draftOrder();
    const second = await draftOrder();

    const a = await issueInvoice(ctxA, { orderId: first.id, kind: "full" });
    const b = await issueInvoice(ctxA, { orderId: second.id, kind: "full" });

    expect(a.number).toBe("INV-2026-0001");
    expect(b.number).toBe("INV-2026-0002");
  });

  it("is gapless and unique when several are issued at once", async () => {
    const orders = await Promise.all(Array.from({ length: 10 }, draftOrder));

    const issued = await Promise.all(
      orders.map((order) => issueInvoice(ctxA, { orderId: order.id, kind: "full" })),
    );

    const numbers = issued.map((invoice) => invoice.number).sort();
    expect(new Set(numbers).size).toBe(10);
    expect(numbers).toEqual(
      Array.from({ length: 10 }, (_, i) => `INV-2026-${String(i + 1).padStart(4, "0")}`),
    );
  });

  it("gives each tenant its own sequence", async () => {
    const mine = await draftOrder();
    const a = await issueInvoice(ctxA, { orderId: mine.id, kind: "full" });

    const theirs = await createOrder(ctxB, { currency: "EUR", lineItems: [boatLine()] });
    const b = await issueInvoice(ctxB, { orderId: theirs.id, kind: "full" });

    // Both are the first invoice their tenant has ever issued.
    expect(a.number).toBe("INV-2026-0001");
    expect(b.number).toBe("INV-2026-0001");
  });

  it("does not reuse a number after one is voided", async () => {
    const order = await draftOrder();
    const first = await issueInvoice(ctxA, { orderId: order.id, kind: "full" });
    const db = await getDb();
    await db
      .collection("invoices")
      .updateOne({ _id: new ObjectId(first.id) }, { $set: { status: "void" } });

    const replacement = await issueInvoice(ctxA, { orderId: order.id, kind: "full" });
    expect(replacement.number).toBe("INV-2026-0002");
  });
});

describe("the ledger", () => {
  it("splits a deposit and a balance that sum to the order", async () => {
    const order = await createOrder(ctxA, {
      currency: "EUR",
      lineItems: [boatLine()],
      deposit: { percent: 30 },
    });

    const deposit = await issueInvoice(ctxA, { orderId: order.id, kind: "deposit" });
    const balance = await issueInvoice(ctxA, { orderId: order.id, kind: "balance" });

    expect(deposit.amountDueMinor).toBe(18_000);
    expect(balance.amountDueMinor).toBe(42_000);

    const ledger = await ledgerForOrder(ctxA, order.id);
    expect(ledger.invoicedMinor).toBe(order.totalMinor);
    expect(ledger.outstandingMinor).toBe(60_000);
  });

  it("tracks the outstanding balance as payments arrive", async () => {
    const order = await createOrder(ctxA, {
      currency: "EUR",
      lineItems: [boatLine()],
      deposit: { percent: 30 },
    });
    await issueInvoice(ctxA, { orderId: order.id, kind: "deposit" });
    await recordPayment(ctxA, order.id, { amountMinor: 18_000 });

    const ledger = await ledgerForOrder(ctxA, order.id);
    expect(ledger.order.status).toBe("confirmed");
    expect(ledger.outstandingMinor).toBe(42_000);
  });
});

describe("tenant isolation", () => {
  it("cannot read another tenant's order", async () => {
    const mine = await createOrder(ctxA, { currency: "EUR", lineItems: [boatLine()] });
    await expect(getOrder(ctxB, mine.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("cannot invoice another tenant's order", async () => {
    const mine = await createOrder(ctxA, { currency: "EUR", lineItems: [boatLine()] });
    await expect(issueInvoice(ctxB, { orderId: mine.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("cannot pay another tenant's order", async () => {
    const mine = await createOrder(ctxA, { currency: "EUR", lineItems: [boatLine()] });
    await expect(recordPayment(ctxB, mine.id, { amountMinor: 1_000 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("does not list another tenant's invoices", async () => {
    const mine = await createOrder(ctxA, { currency: "EUR", lineItems: [boatLine()] });
    await issueInvoice(ctxA, { orderId: mine.id });

    const theirs = await listInvoices(ctxB, {});
    expect(theirs.items).toHaveLength(0);
  });
});
