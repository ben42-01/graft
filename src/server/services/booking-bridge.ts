/**
 * The bridge from a public form submission to the operational layer — the edge
 * docs/BMS_EXTENSION.md §3.1 draws as `CustomerAction.order_id` and
 * `ResourceAllocation.action_id`, and the one edge the BMS extension shipped
 * without.
 *
 * Before this, a booking form did exactly what every other form does: it wrote
 * a record and a submission. The inventory engine, the order pipeline and the
 * operations board were all real and all empty, because nothing in the product
 * ever raised an order against a form submission. A customer could book a boat
 * and the business would find out by reading the records list.
 *
 * Five things matter enough to call out:
 *
 *   - **It runs inside the submission's own transaction.** The record, the
 *     allocation and the order are one write or none. An allocation without
 *     its order is capacity blocked by nothing; an order without its
 *     allocation is a promise against a boat somebody else can still take. The
 *     transaction is why this module exports a session-taking function rather
 *     than calling `holdResource` and `createOrder`, both of which open
 *     transactions of their own.
 *   - **Capacity conflicts fail the submission; missing configuration does
 *     not.** If the resource is genuinely taken, the customer must be told —
 *     accepting a booking that cannot be honoured is the worst outcome
 *     available. But if the tenant never made the resource bookable, the
 *     customer did nothing wrong: the submission stands, the order is still
 *     raised so the request is visible in the pipeline, and the allocation is
 *     simply absent.
 *   - **The hold does not lapse.** `holdResource`'s lease exists for a
 *     checkout somebody is actively clicking through; a booking request is not
 *     that. The allocation is written `held` with `expiresAt: null`, which
 *     blocks capacity (`overlapFilter` matches a null expiry) until the order
 *     it belongs to is confirmed or cancelled — both of which already move
 *     their allocations (`transitionOrder`).
 *   - **The order is a `draft`.** A submission is a request, not a sale, and
 *     `draft` is the pipeline's first column — so a new booking appears at the
 *     left of the operations board and the operator moves it, rather than the
 *     platform deciding on their behalf that the money is owed.
 *   - **Prices come off the resource's own record, once.** `resourceLineItem`
 *     already knows how to read `hourly_rate`/`daily_rate`/`flat_rate` and
 *     snapshot the result, so a rate change tomorrow does not re-price a
 *     booking taken today. A resource with no rate set yields a zero-rated
 *     line rather than a refused booking — the same call pricing.ts already
 *     makes.
 */
import { ObjectId, type ClientSession } from "mongodb";
import { getDb } from "@/server/db/mongo";
import { AppError } from "@/server/http/envelope";
import { parse } from "@/server/http/validate";
import { createLogger } from "@/server/log";
import { allocateInSession, availabilityQuerySchema } from "./availability";
import type { InventoryPoolDoc } from "./inventory";
import { draftOrderFields, type OrderDoc } from "./orders";
import { resourceLineItem } from "./pricing";
import type { BookingConfig } from "./forms";
import type { RecordDoc } from "./records";

/** The resolved "when and how much" of one booking, before any database. */
export type BookingPlan = {
  startAt: Date;
  endAt: Date;
  quantity: number;
};

const MINUTE_MS = 60_000;

/**
 * Reads a date out of submitted data. The compiled entity schema has already
 * turned a `date` field into a `Date` (`compileFieldSchema`), so this is a
 * type guard rather than a parser — but an Invalid Date survives `z.coerce`,
 * and an Invalid Date reaching the availability engine would block a window
 * from NaN to NaN.
 */
function dateAt(data: Record<string, unknown>, key: string, label: string): Date {
  const value = data[key];
  const parsed = value instanceof Date ? value : new Date(String(value ?? ""));
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError("VALIDATION_FAILED", "Invalid request body", {
      source: "body",
      fields: { [key]: `${label} is not a valid date and time` },
    });
  }
  return parsed;
}

/**
 * Turns submitted data into the booking it describes, using nothing but the
 * form's stored config — pure, so the rules about what a booking *is* can be
 * tested without a replica set, which is the same split `resolveSelection`
 * uses on the selection half of this path.
 *
 * `availabilityQuerySchema` does the ordering and span checks rather than a
 * second set of rules here: one definition of "a legal time range" for the
 * engine and for the form in front of it.
 */
export function planBooking(
  booking: BookingConfig,
  data: Record<string, unknown>,
  now: Date,
): BookingPlan {
  const startAt = dateAt(data, booking.startKey, "The start time");
  const endAt =
    booking.endKey !== null
      ? dateAt(data, booking.endKey, "The end time")
      : new Date(startAt.getTime() + (booking.durationMinutes ?? 0) * MINUTE_MS);

  // A booking in the past is never what the customer meant, and accepting one
  // puts a row on the operator's board for a day that has already gone.
  if (startAt.getTime() < now.getTime()) {
    throw new AppError("VALIDATION_FAILED", "Invalid request body", {
      source: "body",
      fields: { [booking.startKey]: "That start time has already passed" },
    });
  }

  const rawQuantity = booking.quantityKey !== null ? data[booking.quantityKey] : undefined;
  const quantity = typeof rawQuantity === "number" ? rawQuantity : 1;

  const {
    startAt: from,
    endAt: to,
    quantity: count,
  } = parse(availabilityQuerySchema, { startAt, endAt, quantity }, "body");
  return { startAt: from, endAt: to, quantity: count };
}

/**
 * The resource's display name, for the line item an invoice will show.
 *
 * Mirrors `resolveRecordLabels` in src/lib/bms/reads.ts, which resolves the
 * same three keys for the operations timeline — the two have to agree, or the
 * board and the invoice would name the same boat differently.
 */
export function resourceName(data: Record<string, unknown>): string {
  for (const key of ["name", "title", "label"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "Booked resource";
}

/**
 * The reads and the one write this needs, session-bound — the same port shape
 * `PublicFormWriteStore` uses, and for the same reason: every one of these
 * runs inside somebody else's transaction, so a test has to be able to stand
 * in for them without mocking the transaction itself away.
 */
export type BookingBridgeStore = {
  /** The pool that makes this record bookable, or null if there isn't one. */
  findPoolByRecord(
    session: ClientSession,
    tenantId: ObjectId,
    recordId: ObjectId,
  ): Promise<(InventoryPoolDoc & { _id: ObjectId }) | null>;
  findRecord(
    session: ClientSession,
    tenantId: ObjectId,
    recordId: ObjectId,
  ): Promise<(RecordDoc & { _id: ObjectId }) | null>;
  insertOrder(session: ClientSession, doc: OrderDoc & { _id: ObjectId }): Promise<void>;
  /** The tenant's own currency, chosen at onboarding. */
  currencyFor(session: ClientSession, tenantId: ObjectId): Promise<string>;
};

/** What onboarding writes, and what a tenant predating that setting gets. */
const FALLBACK_CURRENCY = "EUR";

export function mongoBookingBridgeStore(): BookingBridgeStore {
  return {
    async findPoolByRecord(session, tenantId, recordId) {
      const db = await getDb();
      return db
        .collection<InventoryPoolDoc>("inventory_pools")
        .findOne({ tenantId, recordId, deletedAt: null }, { session });
    },

    async findRecord(session, tenantId, recordId) {
      const db = await getDb();
      return db
        .collection<RecordDoc>("records")
        .findOne({ _id: recordId, tenantId, deletedAt: null }, { session });
    },

    async insertOrder(session, doc) {
      const db = await getDb();
      await db.collection<OrderDoc>("orders").insertOne(doc, { session });
    },

    async currencyFor(session, tenantId) {
      const db = await getDb();
      const tenant = await db
        .collection<{ _id: ObjectId; settings?: { currency?: string } }>("tenants")
        .findOne({ _id: tenantId }, { session, projection: { "settings.currency": 1 } });
      return tenant?.settings?.currency ?? FALLBACK_CURRENCY;
    },
  };
}

export type BridgeResult = {
  orderId: ObjectId;
  /** Null when the resource has no pool — see the module docs. */
  allocationId: ObjectId | null;
};

/**
 * Raises the allocation and the order for one submission, inside the
 * submission's transaction.
 *
 * Returns `null` when there is nothing to bridge — no booking config, or a
 * catalogue submission with no selection — so the caller writes exactly the
 * submission it would have written before this module existed.
 */
export async function bridgeBooking(
  session: ClientSession,
  input: {
    store: BookingBridgeStore;
    requestId: string;
    tenantId: ObjectId;
    booking: BookingConfig | null | undefined;
    /** The catalogue record the visitor picked — the thing being booked. */
    selectedRecordId: ObjectId | null;
    /** The record this submission became, which carries who is booking. */
    submissionRecordId: ObjectId;
    data: Record<string, unknown>;
    now: Date;
  },
): Promise<BridgeResult | null> {
  const { store, tenantId, booking, selectedRecordId, now } = input;
  if (!booking || !selectedRecordId) return null;

  const log = createLogger({ requestId: input.requestId });
  const plan = planBooking(booking, input.data, now);

  const resource = await store.findRecord(session, tenantId, selectedRecordId);
  // `resolveSelection` has already proved this record is in the form's
  // catalogue, so an absent one here means it was deleted between that read
  // and this transaction. Nothing can be priced against it.
  if (!resource) {
    throw new AppError("VALIDATION_FAILED", "Invalid request body", {
      source: "body",
      fields: { _selection: "That item is no longer available" },
    });
  }

  const pool = await store.findPoolByRecord(session, tenantId, selectedRecordId);

  let allocationId: ObjectId | null = null;
  if (pool) {
    // A capacity refusal throws out of the whole transaction — the customer
    // is told the slot is taken and nothing is written, which is the only
    // honest answer available.
    const allocation = await allocateInSession(session, {
      tenantId,
      pool,
      startAt: plan.startAt,
      endAt: plan.endAt,
      quantity: plan.quantity,
      // The submission's record: what the allocation is *for*, resolvable
      // back to the customer who asked for it.
      holderId: input.submissionRecordId,
      expiresAt: null,
      now,
    });
    allocationId = allocation._id;
  } else {
    log.info("booking.bridge.no_pool", {
      tenantId: tenantId.toHexString(),
      recordId: selectedRecordId.toHexString(),
    });
  }

  const lineItem = resourceLineItem({
    name: resourceName(resource.data),
    data: resource.data,
    basis: booking.rateBasis,
    startAt: plan.startAt,
    endAt: plan.endAt,
    quantity: plan.quantity,
    recordId: selectedRecordId.toHexString(),
    ...(pool ? { poolId: pool._id.toHexString() } : {}),
    ...(allocationId ? { allocationId: allocationId.toHexString() } : {}),
  });

  const orderId = new ObjectId();
  await store.insertOrder(session, {
    _id: orderId,
    tenantId,
    ...draftOrderFields({
      // The submission's own record is the customer here: it is where the
      // name, the email and whatever else the form asked for actually live.
      // A separate customer entity is a tenant's modelling decision, not
      // something this path can invent on their behalf.
      customerRecordId: input.submissionRecordId,
      currency: await store.currencyFor(session, tenantId),
      lineItems: [lineItem],
      deposit: booking.depositPercent !== null ? { percent: booking.depositPercent } : null,
      allocationIds: allocationId ? [allocationId] : [],
      notes: null,
    }),
    createdAt: now,
    updatedAt: now,
  });

  return { orderId, allocationId };
}
