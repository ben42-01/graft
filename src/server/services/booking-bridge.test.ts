/**
 * The submission → order/allocation bridge — unit coverage.
 *
 * Everything provable without a replica set lives here: what a booking config
 * means (`planBooking`), and the decision table `bridgeBooking` walks — bridge
 * or don't, allocate or don't, and which failures must take the whole
 * submission down with them. The transactional claim itself (a capacity
 * conflict rolling back the record, the meter and the order together) needs a
 * real MongoDB replica set and belongs with the other transactional proofs in
 * public-forms.integration.test.ts.
 *
 * `allocateInSession` is the one thing stubbed here rather than driven: it is
 * the write-skew guard, it is proven against a real replica set in
 * availability.integration.test.ts, and re-proving it through a mock would
 * prove only that the mock was called.
 */
import { ObjectId, type ClientSession } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/http/envelope";
import type { BookingConfig } from "./forms";
import type { InventoryPoolDoc } from "./inventory";
import type { RecordDoc } from "./records";
import {
  bridgeBooking,
  planBooking,
  resourceName,
  type BookingBridgeStore,
} from "./booking-bridge";

const allocateInSession = vi.hoisted(() => vi.fn());
vi.mock("./availability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./availability")>()),
  allocateInSession,
}));

const TENANT = new ObjectId("000000000000000000000001");
const RESOURCE_ID = new ObjectId("000000000000000000000041");
const SUBMISSION_RECORD_ID = new ObjectId("000000000000000000000051");
const POOL_ID = new ObjectId("000000000000000000000061");
const ALLOCATION_ID = new ObjectId("000000000000000000000071");
const SESSION = {} as ClientSession;

const NOW = new Date("2026-03-01T12:00:00.000Z");
const START = new Date("2026-03-02T09:00:00.000Z");
const END = new Date("2026-03-02T13:00:00.000Z");

const booking = (over: Partial<BookingConfig> = {}): BookingConfig => ({
  startKey: "starts_at",
  endKey: "ends_at",
  durationMinutes: null,
  quantityKey: null,
  rateBasis: "hourly",
  rateKey: null,
  labelKey: null,
  depositPercent: null,
  ...over,
});

const resource = (data: Record<string, unknown> = {}): RecordDoc & { _id: ObjectId } =>
  ({
    _id: RESOURCE_ID,
    tenantId: TENANT,
    entityDefId: new ObjectId("000000000000000000000021"),
    schemaVersion: 1,
    data: { name: "24ft Pontoon Boat", hourly_rate: 150, ...data },
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  }) as RecordDoc & { _id: ObjectId };

const pool = (over: Partial<InventoryPoolDoc> = {}): InventoryPoolDoc & { _id: ObjectId } =>
  ({
    _id: POOL_ID,
    tenantId: TENANT,
    entityDefId: new ObjectId("000000000000000000000021"),
    recordId: RESOURCE_ID,
    strategy: "individual_asset",
    totalQuantity: 1,
    bufferMinutes: 0,
    autoLockOnCheckout: true,
    allocationVersion: 0,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }) as InventoryPoolDoc & { _id: ObjectId };

const store = (over: Partial<BookingBridgeStore> = {}): BookingBridgeStore => ({
  findPoolByRecord: vi.fn().mockResolvedValue(pool()),
  findRecord: vi.fn().mockResolvedValue(resource()),
  insertOrder: vi.fn().mockResolvedValue(undefined),
  currencyFor: vi.fn().mockResolvedValue("EUR"),
  ...over,
});

const bridge = (over: Partial<Parameters<typeof bridgeBooking>[1]> = {}) =>
  bridgeBooking(SESSION, {
    store: store(),
    requestId: "req-booking",
    tenantId: TENANT,
    booking: booking(),
    selectedRecordId: RESOURCE_ID,
    submissionRecordId: SUBMISSION_RECORD_ID,
    data: { starts_at: START, ends_at: END },
    now: NOW,
    ...over,
  });

beforeEach(() => {
  allocateInSession.mockReset();
  allocateInSession.mockResolvedValue({ _id: ALLOCATION_ID });
});

describe("planBooking", () => {
  it("reads the start and end off the fields the config names", () => {
    expect(planBooking(booking(), { starts_at: START, ends_at: END }, NOW)).toEqual({
      startAt: START,
      endAt: END,
      quantity: 1,
    });
  });

  it("derives the end from a fixed duration when there is no end field", () => {
    const plan = planBooking(
      booking({ endKey: null, durationMinutes: 90 }),
      { starts_at: START },
      NOW,
    );
    expect(plan.endAt).toEqual(new Date("2026-03-02T10:30:00.000Z"));
  });

  it("coerces a date the transport delivered as a string", () => {
    const plan = planBooking(
      booking(),
      { starts_at: START.toISOString(), ends_at: END.toISOString() },
      NOW,
    );
    expect(plan).toMatchObject({ startAt: START, endAt: END });
  });

  it("refuses a start that is not a date at all, naming the field", () => {
    expect(() =>
      planBooking(booking(), { starts_at: "next tuesday", ends_at: END }, NOW),
    ).toThrow(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        details: {
          source: "body",
          fields: { starts_at: expect.stringMatching(/valid date/i) },
        },
      }),
    );
  });

  it("refuses a booking that has already started", () => {
    const past = new Date("2026-02-01T09:00:00.000Z");
    expect(() => planBooking(booking(), { starts_at: past, ends_at: END }, NOW)).toThrow(
      expect.objectContaining({
        details: {
          source: "body",
          fields: { starts_at: expect.stringMatching(/already passed/i) },
        },
      }),
    );
  });

  it("refuses an end at or before the start — availabilityQuerySchema's rule, not a second one", () => {
    expect(() => planBooking(booking(), { starts_at: END, ends_at: START }, NOW)).toThrow();
  });

  it("takes the quantity from the field the config names, defaulting to one", () => {
    expect(
      planBooking(
        booking({ quantityKey: "people" }),
        { starts_at: START, ends_at: END, people: 4 },
        NOW,
      ).quantity,
    ).toBe(4);
    expect(
      planBooking(booking({ quantityKey: "people" }), { starts_at: START, ends_at: END }, NOW)
        .quantity,
    ).toBe(1);
  });
});

describe("resourceName", () => {
  it("prefers name, then title, then label — the precedence the timeline uses", () => {
    expect(resourceName({ name: "Boat", title: "T", label: "L" })).toBe("Boat");
    expect(resourceName({ title: "T", label: "L" })).toBe("T");
    expect(resourceName({ label: "L" })).toBe("L");
  });

  it("uses the configured label field instead of the convention", () => {
    expect(resourceName({ boat_name: "Cobra", name: "ignored" }, "boat_name")).toBe("Cobra");
  });

  it("falls back rather than showing an id to a customer", () => {
    expect(resourceName({})).toBe("Booked resource");
    expect(resourceName({ name: "   " })).toBe("Booked resource");
    // A mapping that points at an empty or absent field does not silently
    // fall back to the convention — it was configured, and it is wrong.
    expect(resourceName({ name: "Boat" }, "boat_name")).toBe("Booked resource");
  });
});

describe("bridgeBooking", () => {
  it("does nothing on a form without booking mode", async () => {
    const deps = store();
    expect(await bridge({ booking: null, store: deps })).toBeNull();
    expect(deps.insertOrder).not.toHaveBeenCalled();
    expect(allocateInSession).not.toHaveBeenCalled();
  });

  it("does nothing when the visitor selected no resource", async () => {
    const deps = store();
    expect(await bridge({ selectedRecordId: null, store: deps })).toBeNull();
    expect(deps.insertOrder).not.toHaveBeenCalled();
  });

  it("raises a held, non-lapsing allocation and a draft order", async () => {
    const deps = store();
    const result = await bridge({ store: deps });

    expect(allocateInSession).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        tenantId: TENANT,
        startAt: START,
        endAt: END,
        quantity: 1,
        // A booking request is not a checkout lease — it holds until the
        // order is confirmed or cancelled.
        expiresAt: null,
        holderId: SUBMISSION_RECORD_ID,
      }),
    );
    expect(result).toEqual({ orderId: expect.any(ObjectId), allocationId: ALLOCATION_ID });

    const [, order] = (deps.insertOrder as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(order).toMatchObject({
      tenantId: TENANT,
      status: "draft",
      currency: "EUR",
      allocationIds: [ALLOCATION_ID],
      customerRecordId: SUBMISSION_RECORD_ID,
    });
  });

  it("prices the resource line off the record's own rate, in minor units", async () => {
    const deps = store();
    await bridge({ store: deps });

    const [, order] = (deps.insertOrder as ReturnType<typeof vi.fn>).mock.calls[0];
    // €150/hour × 4 hours, as one unit of "this boat for this booking".
    expect(order.lineItems).toEqual([
      expect.objectContaining({
        kind: "resource",
        description: "24ft Pontoon Boat — 4 hours",
        quantity: 1,
        unitAmountMinor: 60_000,
        amountMinor: 60_000,
        poolId: POOL_ID.toHexString(),
        allocationId: ALLOCATION_ID.toHexString(),
        recordId: RESOURCE_ID.toHexString(),
      }),
    ]);
    expect(order.totalMinor).toBe(60_000);
  });

  it("takes the deposit percent from the form's config", async () => {
    const deps = store();
    await bridge({ store: deps, booking: booking({ depositPercent: 25 }) });

    const [, order] = (deps.insertOrder as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(order.depositMinor).toBe(15_000);
  });

  it("still raises the order when the resource has no pool, so the request is visible", async () => {
    const deps = store({ findPoolByRecord: vi.fn().mockResolvedValue(null) });
    const result = await bridge({ store: deps });

    expect(allocateInSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({ allocationId: null });
    const [, order] = (deps.insertOrder as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(order.allocationIds).toEqual([]);
    expect(order.lineItems[0].allocationId).toBeUndefined();
  });

  it("propagates a capacity conflict rather than booking what cannot be honoured", async () => {
    allocateInSession.mockRejectedValue(
      Object.assign(new Error("taken"), { code: "CONFLICT" }),
    );
    await expect(bridge()).rejects.toThrow("taken");
  });

  it("refuses a selection whose record vanished between validation and this write", async () => {
    const deps = store({ findRecord: vi.fn().mockResolvedValue(null) });
    await expect(bridge({ store: deps })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(deps.insertOrder).not.toHaveBeenCalled();
  });

  it("uses the tenant's own currency", async () => {
    const deps = store({ currencyFor: vi.fn().mockResolvedValue("GBP") });
    await bridge({ store: deps });

    const [, order] = (deps.insertOrder as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(order.currency).toBe("GBP");
  });

  it("zero-rates a resource with no rate rather than refusing the booking", async () => {
    const deps = store({
      findRecord: vi.fn().mockResolvedValue(resource({ hourly_rate: null })),
    });
    await bridge({ store: deps });

    const [, order] = (deps.insertOrder as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(order.totalMinor).toBe(0);
  });
});

/**
 * GRAFT-30.2 — cart mode: one order, one line per item, every line priced off
 * its own record and held against its own pool, all in the one session.
 */
describe("bridgeBooking — cart mode", () => {
  const LOAF = new ObjectId("0000000000000000000000a1");
  const VEG_BOX = new ObjectId("0000000000000000000000a2");
  const LOAF_POOL = new ObjectId("0000000000000000000000b1");
  const VEG_POOL = new ObjectId("0000000000000000000000b2");
  const LOAF_ALLOCATION = new ObjectId("0000000000000000000000c1");
  const VEG_ALLOCATION = new ObjectId("0000000000000000000000c2");

  const flat = (over: Partial<BookingConfig> = {}) =>
    booking({ rateBasis: "flat", rateKey: "price", labelKey: "name", ...over });

  const records: Record<string, Record<string, unknown>> = {
    [LOAF.toHexString()]: { name: "Sourdough loaf", price: 5 },
    [VEG_BOX.toHexString()]: { name: "Veg box", price: 22 },
  };
  const pools: Record<string, ObjectId> = {
    [LOAF.toHexString()]: LOAF_POOL,
    [VEG_BOX.toHexString()]: VEG_POOL,
  };

  const cartStore = (over: Partial<BookingBridgeStore> = {}) =>
    store({
      findRecord: vi.fn(async (_s, _t, id: ObjectId) => {
        const data = records[id.toHexString()];
        return data ? { ...resource(), _id: id, data } : null;
      }),
      findPoolByRecord: vi.fn(async (_s, _t, id: ObjectId) => {
        const poolId = pools[id.toHexString()];
        return poolId ? { ...pool({ recordId: id, totalQuantity: 50 }), _id: poolId } : null;
      }),
      ...over,
    });

  const cart = [
    { recordId: LOAF, quantity: 2 },
    { recordId: VEG_BOX, quantity: 1 },
  ];

  beforeEach(() => {
    allocateInSession.mockImplementation(async (_s, input: { pool: { _id: ObjectId } }) => ({
      _id: input.pool._id.equals(LOAF_POOL) ? LOAF_ALLOCATION : VEG_ALLOCATION,
    }));
  });

  const insertedOrder = (deps: BookingBridgeStore) => {
    expect(deps.insertOrder).toHaveBeenCalledTimes(1);
    return (deps.insertOrder as ReturnType<typeof vi.fn>).mock.calls[0][1];
  };

  it("AC1 — raises exactly one order with a line per item, each priced off its own record", async () => {
    const deps = cartStore();
    const result = await bridge({ store: deps, booking: flat(), selectedRecordId: null, cart });

    const order = insertedOrder(deps);
    expect(order.lineItems).toEqual([
      expect.objectContaining({
        description: "Sourdough loaf",
        quantity: 2,
        unitAmountMinor: 500,
        amountMinor: 1_000,
        recordId: LOAF.toHexString(),
        poolId: LOAF_POOL.toHexString(),
        allocationId: LOAF_ALLOCATION.toHexString(),
      }),
      expect.objectContaining({
        description: "Veg box",
        quantity: 1,
        unitAmountMinor: 2_200,
        amountMinor: 2_200,
        recordId: VEG_BOX.toHexString(),
        allocationId: VEG_ALLOCATION.toHexString(),
      }),
    ]);
    expect(order.totalMinor).toBe(3_200);
    expect(order.allocationIds).toEqual([LOAF_ALLOCATION, VEG_ALLOCATION]);
    expect(result).toEqual({ orderId: expect.any(ObjectId), allocationId: LOAF_ALLOCATION });
  });

  it("AC1 — holds each pooled line for its own quantity, in the one shared window", async () => {
    await bridge({ store: cartStore(), booking: flat(), selectedRecordId: null, cart });

    expect(allocateInSession).toHaveBeenCalledTimes(2);
    expect(allocateInSession).toHaveBeenNthCalledWith(
      1,
      SESSION,
      expect.objectContaining({ quantity: 2, startAt: START, endAt: END, expiresAt: null }),
    );
    expect(allocateInSession).toHaveBeenNthCalledWith(
      2,
      SESSION,
      expect.objectContaining({ quantity: 1, startAt: START, endAt: END, expiresAt: null }),
    );
  });

  it("AC7 — a percentage deposit applies to the order total, rounded down", async () => {
    const deps = cartStore();
    await bridge({
      store: deps,
      booking: flat({ depositPercent: 30 }),
      selectedRecordId: null,
      cart,
    });
    expect(insertedOrder(deps).depositMinor).toBe(960);
  });

  it("AC7 — the deposit rounds down on a total that does not divide evenly", async () => {
    records[LOAF.toHexString()].price = 0.07;
    try {
      const deps = cartStore();
      await bridge({
        store: deps,
        booking: flat({ depositPercent: 30 }),
        selectedRecordId: null,
        cart,
      });
      // 2 × 7 + 2200 = 2214; 30% is 664.2, which `depositFor` floors to 664.
      const order = insertedOrder(deps);
      expect(order.totalMinor).toBe(2_214);
      expect(order.depositMinor).toBe(664);
    } finally {
      records[LOAF.toHexString()].price = 5;
    }
  });

  it("prices a time-based cart by the shared window, per line", async () => {
    const deps = cartStore();
    await bridge({
      store: deps,
      booking: flat({ rateBasis: "hourly" }),
      selectedRecordId: null,
      cart,
    });
    // 4 hours × €5 per loaf, twice; 4 hours × €22 for the box.
    expect(insertedOrder(deps).totalMinor).toBe(2 * 2_000 + 8_800);
  });

  it("raises an unpooled line with no allocation, and still one order", async () => {
    const deps = cartStore({
      findPoolByRecord: vi.fn(async (_s, _t, id: ObjectId) =>
        id.equals(LOAF) ? { ...pool({ recordId: LOAF }), _id: LOAF_POOL } : null,
      ),
    });
    const result = await bridge({ store: deps, booking: flat(), selectedRecordId: null, cart });

    const order = insertedOrder(deps);
    expect(allocateInSession).toHaveBeenCalledTimes(1);
    expect(order.allocationIds).toEqual([LOAF_ALLOCATION]);
    expect(order.lineItems[1].allocationId).toBeUndefined();
    expect(result?.allocationId).toEqual(LOAF_ALLOCATION);
  });

  it("AC3 — a line the pool cannot hold refuses the whole cart, naming that line", async () => {
    allocateInSession.mockImplementation(async (_s, input: { pool: { _id: ObjectId } }) => {
      if (input.pool._id.equals(VEG_POOL)) {
        throw new AppError("CONFLICT", "That resource is not available", {
          capacity: 1,
          used: 1,
          requested: 1,
        });
      }
      return { _id: LOAF_ALLOCATION };
    });
    const deps = cartStore();

    await expect(
      bridge({ store: deps, booking: flat(), selectedRecordId: null, cart }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: expect.objectContaining({
        fields: { "_cart.1": expect.stringMatching(/not enough/i) },
        capacity: 1,
      }),
    });
    expect(deps.insertOrder).not.toHaveBeenCalled();
  });

  it("propagates an error that is not a capacity conflict unchanged", async () => {
    const boom = new Error("socket closed");
    allocateInSession.mockRejectedValue(boom);
    await expect(
      bridge({ store: cartStore(), booking: flat(), selectedRecordId: null, cart }),
    ).rejects.toBe(boom);
  });

  it("AC4 — a line whose record vanished inside the transaction is named and nothing is ordered", async () => {
    const deps = cartStore({
      findRecord: vi.fn(async (_s, _t, id: ObjectId) =>
        id.equals(LOAF)
          ? { ...resource(), _id: LOAF, data: records[LOAF.toHexString()] }
          : null,
      ),
    });
    await expect(
      bridge({ store: deps, booking: flat(), selectedRecordId: null, cart }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fields: { "_cart.1": "That item is no longer available" } },
    });
    expect(deps.insertOrder).not.toHaveBeenCalled();
  });

  it("AC2 — the order stores its amounts, so a later rate change cannot re-price it", async () => {
    const deps = cartStore();
    await bridge({ store: deps, booking: flat(), selectedRecordId: null, cart });
    const order = insertedOrder(deps);
    records[LOAF.toHexString()].price = 999;
    try {
      expect(order.lineItems[0].amountMinor).toBe(1_000);
      expect(order.totalMinor).toBe(3_200);
    } finally {
      records[LOAF.toHexString()].price = 5;
    }
  });

  it("does nothing on a cart form without booking mode, or with an empty cart", async () => {
    const deps = cartStore();
    expect(
      await bridge({ store: deps, booking: null, selectedRecordId: null, cart }),
    ).toBeNull();
    expect(
      await bridge({ store: deps, booking: flat(), selectedRecordId: null, cart: [] }),
    ).toBeNull();
    expect(deps.insertOrder).not.toHaveBeenCalled();
  });
});
