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
