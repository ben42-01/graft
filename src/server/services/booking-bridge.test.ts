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

  it("falls back rather than showing an id to a customer", () => {
    expect(resourceName({})).toBe("Booked resource");
    expect(resourceName({ name: "   " })).toBe("Booked resource");
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
