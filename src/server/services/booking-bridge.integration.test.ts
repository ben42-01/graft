/**
 * The submission → order/allocation bridge against a real MongoDB replica set.
 *
 * The claim this file exists to prove is the one a unit test cannot: that a
 * booking submission writes its record, its allocation and its order in a
 * single transaction, and that a capacity conflict takes *all* of them down
 * together. A double-booked boat and a half-written booking are the two
 * failures that actually cost a business money, and neither is provable
 * against mocks.
 *
 * `MongoMemoryReplSet`, not `MongoMemoryServer`, for the same reason
 * public-forms.integration.test.ts gives: a standalone mongod refuses
 * `session.withTransaction` outright.
 */
import { ObjectId } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getMongoClient } from "@/server/db/mongo";
import { TIER_LIMITS } from "@/server/tiers";
import type { EntityView } from "./entities";
import type { Entitlements } from "./entitlements";
import { submitPublicForm } from "./public-forms";

const TENANT = new ObjectId("000000000000000000000001");
const BOOKINGS_ENTITY = new ObjectId("000000000000000000000021");
const ITEMS_ENTITY = new ObjectId("000000000000000000000022");
const FORM_ID = new ObjectId("000000000000000000000031");
const BOAT = new ObjectId("000000000000000000000041");
const POOL_ID = new ObjectId("000000000000000000000051");

const NOW = new Date("2026-03-20T12:00:00.000Z");
const RENDERED_AT = NOW.getTime() - 5_000;
const START = "2026-03-21T09:00:00.000Z";
const END = "2026-03-21T13:00:00.000Z";

const fields = [
  { key: "customer", label: "Your name", type: "text" as const, required: true },
  { key: "starts_at", label: "From", type: "date" as const, required: true },
  { key: "ends_at", label: "Until", type: "date" as const, required: true },
  { key: "chosen_boat", label: "Boat", type: "text" as const, required: false },
];

const entity = (): EntityView => ({
  id: BOOKINGS_ENTITY.toHexString(),
  key: "bookings",
  name: "Bookings",
  fields,
  schemaVersion: 1,
  createdAt: NOW,
  updatedAt: NOW,
});

const entitlements = (): Entitlements =>
  Object.freeze({
    tenantId: TENANT.toHexString(),
    tier: "free",
    limits: TIER_LIMITS.free,
    features: {} as Entitlements["features"],
    readOnly: [],
    downgradedAt: null,
    billingAnchorDay: 1,
  });

const deps = () => ({
  getEntity: async () => entity(),
  loadEntitlements: async () => entitlements(),
  now: () => NOW,
});

const body = (over: Record<string, unknown> = {}) => ({
  data: { customer: "Ada Lovelace", starts_at: START, ends_at: END },
  _t: RENDERED_AT,
  _selection: BOAT.toHexString(),
  ...over,
});

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, dbName: "graft_booking_bridge" },
  });
  process.env.MONGODB_URI = replSet.getUri("graft_booking_bridge");
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  process.env.APP_ENV = "qa";

  const db = await getDb();
  await db
    .collection("usage_meters")
    .createIndex({ tenantId: 1, meter: 1, period: 1 }, { unique: true });
}, 60_000);

afterAll(async () => {
  const client = await getMongoClient();
  await client.close();
  await replSet.stop();
});

/** A pool for the boat, unless a test wants the unbookable case. */
async function seed({ withPool = true }: { withPool?: boolean } = {}) {
  const db = await getDb();
  await Promise.all(
    [
      "records",
      "form_submissions",
      "usage_meters",
      "forms",
      "inventory_pools",
      "resource_allocations",
      "orders",
      "tenants",
    ].map((name) => db.collection(name).deleteMany({})),
  );

  await db.collection("tenants").insertOne({
    _id: TENANT,
    name: "Acme Rentals",
    slug: "acme",
    tier: "free",
    settings: { currency: "EUR", timezone: "UTC", locale: "en" },
    createdAt: NOW,
    updatedAt: NOW,
  });

  await db.collection("records").insertOne({
    _id: BOAT,
    tenantId: TENANT,
    entityDefId: ITEMS_ENTITY,
    schemaVersion: 1,
    data: { name: "24ft Pontoon Boat", hourly_rate: 150 },
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

  await db.collection("forms").insertOne({
    _id: FORM_ID,
    tenantId: TENANT,
    entityDefId: BOOKINGS_ENTITY,
    name: "Book a boat",
    slug: "book-a-boat",
    publicSlug: "acme/book-a-boat",
    visibility: "public",
    published: true,
    enabled: true,
    killSwitchAt: null,
    killSwitchBy: null,
    fields,
    catalogue: {
      entityDefId: ITEMS_ENTITY,
      fields: ["name"],
      imageField: null,
      pageSize: 12,
      selectionKey: "chosen_boat",
    },
    booking: {
      startKey: "starts_at",
      endKey: "ends_at",
      durationMinutes: null,
      quantityKey: null,
      rateBasis: "hourly",
      depositPercent: 25,
    },
    showBadge: true,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

  if (withPool) {
    await db.collection("inventory_pools").insertOne({
      _id: POOL_ID,
      tenantId: TENANT,
      entityDefId: ITEMS_ENTITY,
      recordId: BOAT,
      strategy: "individual_asset",
      totalQuantity: 1,
      bufferMinutes: 0,
      autoLockOnCheckout: true,
      allocationVersion: 0,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
}

beforeEach(() => seed());

describe("a booking form's submission", () => {
  it("writes the record, the allocation and the order together, and links them", async () => {
    const { submissionId } = await submitPublicForm(
      "req-book",
      ["acme", "book-a-boat"],
      body(),
      deps(),
    );

    const db = await getDb();
    const submission = await db
      .collection("form_submissions")
      .findOne({ _id: new ObjectId(submissionId) });
    const allocation = await db
      .collection("resource_allocations")
      .findOne({ tenantId: TENANT });
    const order = await db.collection("orders").findOne({ tenantId: TENANT });

    expect(allocation).toMatchObject({
      poolId: POOL_ID,
      recordId: BOAT,
      status: "held",
      // A booking request holds until the operator decides — it is not a
      // checkout lease that lapses under them.
      expiresAt: null,
      startAt: new Date(START),
      endAt: new Date(END),
    });
    // The allocation's holder is the record the submission became, so an
    // operator can get from a row on the timeline back to who booked it.
    expect(allocation?.holderId).toEqual(submission?.recordId);

    expect(order).toMatchObject({
      status: "draft",
      currency: "EUR",
      allocationIds: [allocation?._id],
      // €150/hour × 4 hours, with the form's 25% deposit.
      totalMinor: 60_000,
      depositMinor: 15_000,
    });

    expect(submission).toMatchObject({
      selectedRecordId: BOAT,
      orderId: order?._id,
      allocationId: allocation?._id,
    });
  });

  it("refuses a second booking of the same boat at the same time, writing nothing", async () => {
    await submitPublicForm("req-book", ["acme", "book-a-boat"], body(), deps());

    await expect(
      submitPublicForm("req-book-2", ["acme", "book-a-boat"], body(), deps()),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const db = await getDb();
    // Exactly what was written by the first, successful booking — the refused
    // one left no record, no order and no meter increment behind it.
    expect(await db.collection("resource_allocations").countDocuments()).toBe(1);
    expect(await db.collection("orders").countDocuments()).toBe(1);
    expect(await db.collection("form_submissions").countDocuments()).toBe(1);
    expect(
      await db.collection("records").countDocuments({ entityDefId: BOOKINGS_ENTITY }),
    ).toBe(1);
    const meter = await db
      .collection("usage_meters")
      .findOne({ tenantId: TENANT, meter: "form_submissions" });
    expect(meter?.count).toBe(1);
  });

  it("takes a back-to-back booking, because time ranges are half-open", async () => {
    await submitPublicForm("req-book", ["acme", "book-a-boat"], body(), deps());
    await submitPublicForm(
      "req-book-2",
      ["acme", "book-a-boat"],
      body({
        data: {
          customer: "Grace Hopper",
          starts_at: END,
          ends_at: "2026-03-21T17:00:00.000Z",
        },
      }),
      deps(),
    );

    const db = await getDb();
    expect(await db.collection("resource_allocations").countDocuments()).toBe(2);
    expect(await db.collection("orders").countDocuments()).toBe(2);
  });

  it("still raises an order when the boat has no pool, so the request is not lost", async () => {
    await seed({ withPool: false });
    const { submissionId } = await submitPublicForm(
      "req-book",
      ["acme", "book-a-boat"],
      body(),
      deps(),
    );

    const db = await getDb();
    const order = await db.collection("orders").findOne({ tenantId: TENANT });
    const submission = await db
      .collection("form_submissions")
      .findOne({ _id: new ObjectId(submissionId) });

    expect(await db.collection("resource_allocations").countDocuments()).toBe(0);
    expect(order).toMatchObject({ status: "draft", allocationIds: [], totalMinor: 60_000 });
    expect(submission).toMatchObject({ orderId: order?._id, allocationId: null });
  });
});

/**
 * GRAFT-30.2 — a cart submission: one order, a line per item, an allocation
 * per pooled line, and the whole lot committed or refused together.
 */
describe("a cart form's submission", () => {
  const SHOP_ENTITY = new ObjectId("000000000000000000000023");
  const CART_FORM_ID = new ObjectId("000000000000000000000032");
  const LOAF = new ObjectId("0000000000000000000000a1");
  const VEG_BOX = new ObjectId("0000000000000000000000a2");
  const OVEN = new ObjectId("0000000000000000000000a3");
  const FOREIGN = new ObjectId("0000000000000000000000a4");
  const OTHER_TENANT = new ObjectId("000000000000000000000002");

  const cartFields = [
    { key: "customer", label: "Your name", type: "text" as const, required: true },
    { key: "starts_at", label: "From", type: "date" as const, required: true },
    { key: "ends_at", label: "Until", type: "date" as const, required: true },
    { key: "basket", label: "Basket", type: "text" as const, required: false },
  ];

  const cartDeps = (over: { submissionsPerMonth?: number } = {}) => ({
    ...deps(),
    getEntity: async () => ({ ...entity(), fields: cartFields }),
    loadEntitlements: async () =>
      Object.freeze({
        ...entitlements(),
        limits: {
          ...TIER_LIMITS.free,
          ...(over.submissionsPerMonth !== undefined
            ? { submissionsPerMonth: over.submissionsPerMonth }
            : {}),
        },
      }),
  });

  const cartBody = (cart: Array<{ recordId: ObjectId; quantity: number }>) => ({
    data: { customer: "Ada Lovelace", starts_at: START, ends_at: END, basket: "forged" },
    _t: RENDERED_AT,
    _cart: cart.map((line) => ({
      recordId: line.recordId.toHexString(),
      quantity: line.quantity,
    })),
  });

  const submitCart = (cart: Array<{ recordId: ObjectId; quantity: number }>, d = cartDeps()) =>
    submitPublicForm("req-cart", ["acme", "shop"], cartBody(cart), d);

  const record = (_id: ObjectId, data: Record<string, unknown>, tenantId = TENANT) => ({
    _id,
    tenantId,
    entityDefId: SHOP_ENTITY,
    schemaVersion: 1,
    data,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

  const shopPool = (recordId: ObjectId, totalQuantity: number) => ({
    _id: new ObjectId(),
    tenantId: TENANT,
    entityDefId: SHOP_ENTITY,
    recordId,
    strategy: "pooled_quantity",
    totalQuantity,
    bufferMinutes: 0,
    autoLockOnCheckout: true,
    allocationVersion: 0,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

  beforeEach(async () => {
    const db = await getDb();
    await db
      .collection("records")
      .insertMany([
        record(LOAF, { name: "Sourdough loaf", price: 5 }),
        record(VEG_BOX, { name: "Veg box", price: 22 }),
        record(OVEN, { name: "Wood-fired oven", price: 40 }),
        record(FOREIGN, { name: "Someone else's loaf", price: 1 }, OTHER_TENANT),
      ]);
    await db
      .collection("inventory_pools")
      .insertMany([shopPool(LOAF, 50), shopPool(VEG_BOX, 50), shopPool(OVEN, 1)]);
    await db.collection("forms").insertOne({
      _id: CART_FORM_ID,
      tenantId: TENANT,
      entityDefId: BOOKINGS_ENTITY,
      name: "Farm shop",
      slug: "shop",
      publicSlug: "acme/shop",
      visibility: "public",
      published: true,
      enabled: true,
      killSwitchAt: null,
      killSwitchBy: null,
      fields: cartFields,
      catalogue: {
        entityDefId: SHOP_ENTITY,
        fields: ["name", "price"],
        imageField: null,
        pageSize: 12,
        selectionKey: "basket",
        multiple: true,
      },
      booking: {
        startKey: "starts_at",
        endKey: "ends_at",
        durationMinutes: null,
        quantityKey: null,
        rateBasis: "flat",
        rateKey: "price",
        labelKey: "name",
        depositPercent: 30,
      },
      showBadge: true,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  /** Everything a refused cart must not have left behind. */
  async function expectNothingWritten() {
    const db = await getDb();
    expect(await db.collection("orders").countDocuments()).toBe(0);
    expect(await db.collection("resource_allocations").countDocuments()).toBe(0);
    expect(await db.collection("form_submissions").countDocuments()).toBe(0);
    expect(
      await db.collection("records").countDocuments({ entityDefId: BOOKINGS_ENTITY }),
    ).toBe(0);
    const meter = await db
      .collection("usage_meters")
      .findOne({ tenantId: TENANT, meter: "form_submissions" });
    expect(meter?.count ?? 0).toBe(0);
  }

  it("AC1, AC7, AC8 — writes one order with a line per item, its allocations and a readable summary", async () => {
    const { submissionId } = await submitCart([
      { recordId: LOAF, quantity: 2 },
      { recordId: VEG_BOX, quantity: 1 },
    ]);

    const db = await getDb();
    const orders = await db.collection("orders").find({ tenantId: TENANT }).toArray();
    const allocations = await db
      .collection("resource_allocations")
      .find({ tenantId: TENANT })
      .sort({ quantity: -1 })
      .toArray();
    const submission = await db
      .collection("form_submissions")
      .findOne({ _id: new ObjectId(submissionId) });
    const submitted = await db.collection("records").findOne({ _id: submission?.recordId });

    expect(orders).toHaveLength(1);
    const [order] = orders;
    expect(order.lineItems).toEqual([
      expect.objectContaining({
        quantity: 2,
        unitAmountMinor: 500,
        amountMinor: 1_000,
        recordId: LOAF.toHexString(),
      }),
      expect.objectContaining({
        quantity: 1,
        unitAmountMinor: 2_200,
        amountMinor: 2_200,
        recordId: VEG_BOX.toHexString(),
      }),
    ]);
    // AC7 — 30% of the order total, not of any one line.
    expect(order).toMatchObject({ status: "draft", totalMinor: 3_200, depositMinor: 960 });

    expect(allocations.map((row) => [row.recordId, row.quantity])).toEqual([
      [LOAF, 2],
      [VEG_BOX, 1],
    ]);
    expect(order.allocationIds).toEqual(
      expect.arrayContaining(allocations.map((row) => row._id)),
    );
    for (const allocation of allocations) {
      expect(allocation).toMatchObject({
        startAt: new Date(START),
        endAt: new Date(END),
        holderId: submission?.recordId,
        expiresAt: null,
      });
    }

    // AC8 — the visitor's "forged" is overwritten; the order lines, not this
    // string, are what link the submission to records.
    expect(submitted?.data.basket).toBe("2 × Sourdough loaf, 1 × Veg box");
    expect(submission).toMatchObject({ orderId: order._id, selectedRecordId: null });
  });

  it("AC2 — a rate change after submission does not re-price the order", async () => {
    await submitCart([{ recordId: LOAF, quantity: 2 }]);
    const db = await getDb();
    await db.collection("records").updateOne({ _id: LOAF }, { $set: { "data.price": 9 } });

    const order = await db.collection("orders").findOne({ tenantId: TENANT });
    expect(order?.lineItems[0]).toMatchObject({ unitAmountMinor: 500, amountMinor: 1_000 });
    expect(order?.totalMinor).toBe(1_000);
  });

  it("AC3 — a line its pool cannot hold refuses the whole cart and writes nothing for any line", async () => {
    await expect(
      submitCart([
        { recordId: LOAF, quantity: 1 },
        { recordId: OVEN, quantity: 2 },
      ]),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: expect.objectContaining({ fields: { "_cart.1": expect.any(String) } }),
    });
    // The loaf was held first, inside the same transaction — and is gone.
    await expectNothingWritten();
  });

  it("AC4 — a record from another entity, another tenant or deleted is refused and nothing is written", async () => {
    const db = await getDb();
    await db.collection("records").updateOne({ _id: VEG_BOX }, { $set: { deletedAt: NOW } });

    for (const [cart, index] of [
      [
        [
          { recordId: LOAF, quantity: 1 },
          { recordId: BOAT, quantity: 1 },
        ],
        1,
      ],
      [[{ recordId: FOREIGN, quantity: 1 }], 0],
      [
        [
          { recordId: LOAF, quantity: 1 },
          { recordId: VEG_BOX, quantity: 1 },
        ],
        1,
      ],
    ] as const) {
      await expect(submitCart([...cart])).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        details: { fields: { [`_cart.${index}`]: "That item is no longer available" } },
      });
    }
    await expectNothingWritten();
  });

  it("AC9 — a cart consumes one submission unit, and is refused at the quota boundary", async () => {
    const limited = cartDeps({ submissionsPerMonth: 1 });
    await submitCart(
      [
        { recordId: LOAF, quantity: 2 },
        { recordId: VEG_BOX, quantity: 1 },
      ],
      limited,
    );

    const db = await getDb();
    const meter = await db
      .collection("usage_meters")
      .findOne({ tenantId: TENANT, meter: "form_submissions" });
    expect(meter?.count).toBe(1);

    await expect(submitCart([{ recordId: LOAF, quantity: 1 }], limited)).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });
    expect(await db.collection("orders").countDocuments()).toBe(1);
    expect(await db.collection("resource_allocations").countDocuments()).toBe(2);
  });

  it("AC6 — a single selection on the cart form is refused, not ignored", async () => {
    await expect(
      submitPublicForm(
        "req-cart",
        ["acme", "shop"],
        {
          data: { customer: "Ada", starts_at: START, ends_at: END },
          _t: RENDERED_AT,
          _selection: LOAF.toHexString(),
        },
        cartDeps(),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expectNothingWritten();
  });
});
