/**
 * The availability engine — `is_available` as the single source of truth, plus
 * the pessimistic hold that makes it mean something (docs/BMS_EXTENSION.md
 * §2.1, Step 2).
 *
 * Five things matter enough to call out:
 *
 *   - **Buffers are baked into the stored allocation, not applied at query
 *     time.** Every allocation records `blockedFrom = startAt - buffer` and
 *     `blockedUntil = endAt + buffer`, so an overlap test is a plain range
 *     comparison an index can serve. Reading the buffer at query time instead
 *     would mean every availability check re-derives it for every candidate
 *     row, and a later buffer change would silently rewrite history.
 *   - **The buffer is applied to the stored side only, never to the request.**
 *     Applying it to both would double the gap: 30 minutes of cleaning after a
 *     booking plus 30 before the next one is an hour nobody asked for. One
 *     side, on both ends, gives exactly the configured separation in either
 *     direction.
 *   - **Snapshot isolation is not enough, so every allocation touches the pool
 *     document.** Two concurrent transactions can both read "capacity 1, used
 *     0" and both insert *different* documents — no write conflict, and the
 *     boat is double-booked. This is write skew, and MongoDB's snapshot
 *     isolation does not prevent it. Bumping `allocationVersion` on the shared
 *     pool document inside the transaction turns the two into a genuine write
 *     conflict, and `withTransaction` retries the loser, which then re-reads
 *     and correctly sees the first allocation. *Any* write to the pool
 *     document would serialise; `$inc` is chosen because it is monotonic and
 *     says what it is for. Dropping the write as redundant — nothing reads
 *     `allocationVersion` — silently reintroduces double-booking:
 *     availability.integration.test.ts was run without it and 7 of 8
 *     concurrent holds took the same single asset.
 *   - **An expired hold is invisible, not deleted.** Availability filters on
 *     `expiresAt`, so a lapsed checkout stops blocking the instant it lapses,
 *     with no sweeper in the loop. A TTL index reclaims the rows eventually;
 *     correctness never waits for it.
 *   - **Time ranges are half-open, `[startAt, endAt)`.** A 10:00–12:00 booking
 *     and a 12:00–14:00 booking do not overlap. Anything else makes
 *     back-to-back slots un-bookable at every boundary.
 */
import { ObjectId, type ClientSession, type Filter } from "mongodb";
import { z } from "zod";
import type { Ctx } from "@/server/context";
import { getDb, getMongoClient } from "@/server/db/mongo";
import { AppError } from "@/server/http/envelope";
import { clampLimit } from "@/server/http/pagination";
import { parse } from "@/server/http/validate";
import { createRepository, type Repository } from "@/server/repositories/base";
import { findPoolDoc as findPoolDocDefault, type InventoryPoolDoc } from "./inventory";

const objectIdHex = z.string().regex(/^[0-9a-f]{24}$/i, "Expected a 24-character id");

/** How long a checkout may hold a resource before it lapses (§2.1: "10-minute hold"). */
export const DEFAULT_HOLD_MINUTES = 10;
export const MAX_HOLD_MINUTES = 60;

/** A booking longer than this is a data-entry slip, not a rental. */
export const MAX_ALLOCATION_DAYS = 366;

/**
 * `held` and `confirmed` both consume capacity; `released` and `cancelled`
 * consume none. The distinction between the last two is intent, not effect —
 * a customer cancelling and a hold being given up read very differently in an
 * operations log.
 */
export const ALLOCATION_STATUSES = ["held", "confirmed", "released", "cancelled"] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number];

/** The statuses that occupy the resource. The one list availability trusts. */
export const BLOCKING_STATUSES: readonly AllocationStatus[] = ["held", "confirmed"];

const isoDate = z.union([z.string(), z.date()]).pipe(z.coerce.date());

export const availabilityQuerySchema = z
  .object({
    startAt: isoDate,
    endAt: isoDate,
    quantity: z.coerce.number().int().positive().default(1),
  })
  .refine((v) => v.endAt > v.startAt, {
    message: "endAt must be after startAt",
    path: ["endAt"],
  })
  .refine((v) => v.endAt.getTime() - v.startAt.getTime() <= MAX_ALLOCATION_DAYS * 86_400_000, {
    message: `A single allocation cannot span more than ${MAX_ALLOCATION_DAYS} days`,
    path: ["endAt"],
  });

export const holdSchema = z.object({
  startAt: isoDate,
  endAt: isoDate,
  quantity: z.coerce.number().int().positive().default(1),
  holdMinutes: z.coerce.number().int().positive().max(MAX_HOLD_MINUTES).optional(),
  /**
   * What the hold is for — a form submission, later an order. Optional because
   * a hold is taken *before* the thing it belongs to exists; that is the point
   * of a checkout lock.
   */
  holderId: objectIdHex.optional(),
});

export const allocationIdParamSchema = z.object({ allocationId: objectIdHex });

export type HoldInput = z.input<typeof holdSchema>;

export type ResourceAllocationDoc = {
  tenantId: ObjectId;
  poolId: ObjectId;
  /** Denormalised so a timeline can be drawn without loading every pool. */
  recordId: ObjectId;
  /** The order or submission this belongs to; null while it is only a hold. */
  holderId: ObjectId | null;
  startAt: Date;
  endAt: Date;
  /** `startAt` minus the pool's buffer, frozen at write time. */
  blockedFrom: Date;
  /** `endAt` plus the pool's buffer, frozen at write time. */
  blockedUntil: Date;
  quantity: number;
  status: AllocationStatus;
  /** Set only while `held`; null once confirmed, released or cancelled. */
  expiresAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AllocationView = {
  id: string;
  poolId: string;
  recordId: string;
  holderId: string | null;
  startAt: Date;
  endAt: Date;
  blockedFrom: Date;
  blockedUntil: Date;
  quantity: number;
  status: AllocationStatus;
  expiresAt: Date | null;
};

export type AvailabilityResult = {
  available: boolean;
  poolId: string;
  strategy: InventoryPoolDoc["strategy"];
  /** The pool's ceiling. */
  capacity: number;
  /** How much of it is taken across the requested window. */
  used: number;
  /** What is left. Never negative — an over-committed pool reports 0. */
  remaining: number;
  requested: number;
  bufferMinutes: number;
};

const allocationsRepo = createRepository<ResourceAllocationDoc>("resource_allocations");

const minutes = (n: number) => n * 60_000;

export function toAllocationView(
  doc: ResourceAllocationDoc & { _id: ObjectId },
): AllocationView {
  return {
    id: doc._id.toHexString(),
    poolId: doc.poolId.toHexString(),
    recordId: doc.recordId.toHexString(),
    holderId: doc.holderId ? doc.holderId.toHexString() : null,
    startAt: doc.startAt,
    endAt: doc.endAt,
    blockedFrom: doc.blockedFrom,
    blockedUntil: doc.blockedUntil,
    quantity: doc.quantity,
    status: doc.status,
    expiresAt: doc.expiresAt,
  };
}

/** The blocked window an allocation actually occupies, buffer included. */
export function blockedWindow(
  startAt: Date,
  endAt: Date,
  bufferMinutes: number,
): { blockedFrom: Date; blockedUntil: Date } {
  return {
    blockedFrom: new Date(startAt.getTime() - minutes(bufferMinutes)),
    blockedUntil: new Date(endAt.getTime() + minutes(bufferMinutes)),
  };
}

/**
 * The overlap filter, kept in one place because it is the only thing standing
 * between the product and a double booking.
 *
 * Half-open on both sides: `blockedFrom < requestedEnd` and `blockedUntil >
 * requestedStart`. A row whose blocked window ends exactly when the request
 * begins does not overlap it.
 *
 * `expiresAt` is part of the filter, not a post-filter: an expired hold must
 * cost nothing, and the database is where "now" is compared so a caller cannot
 * forget to do it.
 */
export function overlapFilter(
  poolId: ObjectId,
  startAt: Date,
  endAt: Date,
  now: Date,
): Filter<ResourceAllocationDoc> {
  return {
    poolId,
    status: { $in: [...BLOCKING_STATUSES] },
    blockedFrom: { $lt: endAt },
    blockedUntil: { $gt: startAt },
    // Confirmed rows have `expiresAt: null` and are matched by the first
    // branch; held rows are matched only while their lease is still running.
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  } as Filter<ResourceAllocationDoc>;
}

export type AvailabilityDeps = {
  allocations: Repository<ResourceAllocationDoc>;
  findPool: (
    ctx: Ctx,
    poolId: string,
  ) => Promise<(InventoryPoolDoc & { _id: ObjectId }) | null>;
  now: () => Date;
};

function resolveDeps(overrides: Partial<AvailabilityDeps> = {}): AvailabilityDeps {
  return {
    allocations: overrides.allocations ?? allocationsRepo,
    findPool: overrides.findPool ?? ((ctx, poolId) => findPoolDocDefault(ctx, poolId)),
    now: overrides.now ?? (() => new Date()),
  };
}

async function poolOrThrow(deps: AvailabilityDeps, ctx: Ctx, poolId: string) {
  const pool = await deps.findPool(ctx, poolId);
  if (!pool) throw new AppError("NOT_FOUND", "Inventory pool not found");
  return pool;
}

/**
 * **The overbooking-protection API of §2.1** — the single source of truth every
 * other path in this module is built on, exposed directly so a checkout screen
 * can ask before it commits a customer to anything.
 *
 * Read-only and racy by nature: an answer is true at the instant it is given
 * and nothing more. `holdResource` re-asks the same question inside a
 * transaction, which is what makes a booking safe; this one exists so a UI can
 * grey out a date without taking a lock to do it.
 */
export async function isAvailable(
  ctx: Ctx,
  poolId: string,
  query: unknown,
  overrides: Partial<AvailabilityDeps> = {},
): Promise<AvailabilityResult> {
  const deps = resolveDeps(overrides);
  const { startAt, endAt, quantity } = parse(availabilityQuerySchema, query, "query");
  const pool = await poolOrThrow(deps, ctx, poolId);

  const used = await usedCapacity(deps, ctx, pool, startAt, endAt, deps.now());
  const remaining = Math.max(0, pool.totalQuantity - used);

  return {
    available: quantity <= remaining,
    poolId: pool._id.toHexString(),
    strategy: pool.strategy,
    capacity: pool.totalQuantity,
    used,
    remaining,
    requested: quantity,
    bufferMinutes: pool.bufferMinutes,
  };
}

/**
 * Summed rather than counted: a pooled allocation of 4 kayaks takes 4 of the
 * 50, not 1 of the 50. For an `individual_asset` pool every row is quantity 1
 * and a capacity of 1, so the same arithmetic yields the boolean the strategy
 * implies without a second code path.
 */
async function usedCapacity(
  deps: AvailabilityDeps,
  ctx: Ctx,
  pool: InventoryPoolDoc & { _id: ObjectId },
  startAt: Date,
  endAt: Date,
  now: Date,
): Promise<number> {
  const overlapping = await deps.allocations.find(
    ctx,
    overlapFilter(pool._id, startAt, endAt, now),
  );
  return overlapping.reduce((total, row) => total + row.quantity, 0);
}

/**
 * The transactional body of a hold: bump, re-count, insert. Extracted from
 * `holdResource` because it has a second caller — a public booking form writes
 * its record, its allocation and its order in *one* transaction (see
 * booking-bridge.ts), and a second hand-rolled copy of the write-skew guard is
 * a second place for a double booking to come from.
 *
 * Takes an already-open session and an already-loaded pool, and does no
 * parsing: everything it is given has been validated by whichever caller is
 * driving the transaction it runs inside.
 *
 * `expiresAt: null` is a hold that does not lapse — what a booking *request*
 * is, as distinct from a checkout lease. It blocks capacity (`overlapFilter`
 * matches a null expiry) until the order it belongs to is confirmed or
 * cancelled.
 */
export async function allocateInSession(
  session: ClientSession,
  input: {
    tenantId: ObjectId;
    pool: InventoryPoolDoc & { _id: ObjectId };
    startAt: Date;
    endAt: Date;
    quantity: number;
    holderId: ObjectId | null;
    expiresAt: Date | null;
    now: Date;
  },
): Promise<ResourceAllocationDoc & { _id: ObjectId }> {
  const { tenantId, pool, startAt, endAt, quantity, now } = input;
  const db = await getDb();

  // The serialisation point. Any other transaction holding against this
  // pool writes the same document, so exactly one of them commits and the
  // rest are retried against the state it left behind.
  const bumped = await db
    .collection<InventoryPoolDoc>("inventory_pools")
    .findOneAndUpdate(
      { _id: pool._id, tenantId, deletedAt: null },
      { $inc: { allocationVersion: 1 }, $set: { updatedAt: now } },
      { session, returnDocument: "after" },
    );
  if (!bumped) throw new AppError("NOT_FOUND", "Inventory pool not found");

  const overlapping = await db
    .collection<ResourceAllocationDoc>("resource_allocations")
    .find(
      { ...overlapFilter(pool._id, startAt, endAt, now), tenantId, deletedAt: null },
      { session },
    )
    .toArray();
  const used = overlapping.reduce((total, row) => total + row.quantity, 0);

  // `bumped` rather than `pool`: capacity may have been edited between the
  // read above and this transaction, and the transactional read is the
  // one that decides.
  if (used + quantity > bumped.totalQuantity) {
    throw new AppError("CONFLICT", "That resource is not available for the requested time", {
      capacity: bumped.totalQuantity,
      used,
      requested: quantity,
    });
  }

  const { blockedFrom, blockedUntil } = blockedWindow(startAt, endAt, bumped.bufferMinutes);
  const doc: ResourceAllocationDoc = {
    tenantId,
    poolId: pool._id,
    recordId: pool.recordId,
    holderId: input.holderId,
    startAt,
    endAt,
    blockedFrom,
    blockedUntil,
    quantity,
    status: "held",
    expiresAt: input.expiresAt,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const { insertedId } = await db
    .collection<ResourceAllocationDoc>("resource_allocations")
    .insertOne(doc, { session });
  return { ...doc, _id: insertedId };
}

/**
 * **The pessimistic time-lock of §2.1.** Re-checks availability *inside* a
 * transaction and, in the same transaction, bumps the pool's
 * `allocationVersion` so a concurrent hold on the same pool conflicts rather
 * than quietly succeeding beside it (see the module docs — this is the write
 * skew guard, not a redundant write).
 *
 * The lease is short by design. A hold nobody confirms costs the business a
 * few minutes of a resource's calendar and then stops costing anything.
 */
export async function holdResource(
  ctx: Ctx,
  poolId: string,
  input: unknown,
  overrides: Partial<AvailabilityDeps> = {},
): Promise<AllocationView> {
  const deps = resolveDeps(overrides);
  const parsed = parse(holdSchema, input, "body");
  const { startAt, endAt, quantity } = parse(availabilityQuerySchema, parsed, "body");

  const pool = await poolOrThrow(deps, ctx, poolId);
  if (!pool.autoLockOnCheckout) {
    throw new AppError("CONFLICT", "This resource does not take checkout holds");
  }

  const now = deps.now();
  const expiresAt = new Date(
    now.getTime() + minutes(parsed.holdMinutes ?? DEFAULT_HOLD_MINUTES),
  );
  const client = await getMongoClient();
  const session = client.startSession();
  const tenantId = new ObjectId(ctx.tenantId);

  try {
    // The callback's return value is the transaction's, so there is no
    // outer `let` for a retried attempt to leave stale.
    const created = await session.withTransaction(() =>
      allocateInSession(session, {
        tenantId,
        pool,
        startAt,
        endAt,
        quantity,
        holderId: parsed.holderId ? new ObjectId(parsed.holderId) : null,
        expiresAt,
        now,
      }),
    );

    return toAllocationView(created);
  } finally {
    await session.endSession();
  }
}

/**
 * Promotes a live hold to a booking: the lease is dropped, so it stops being
 * something that can lapse. Availability does not need rechecking — the hold
 * has been occupying the capacity the whole time, which is what it was for.
 *
 * An *expired* hold is refused rather than revived. Its capacity has been
 * available to other customers since it lapsed, so confirming it would be
 * granting a resource that may already have been given away.
 */
export async function confirmAllocation(
  ctx: Ctx,
  allocationId: string,
  holderId: string | undefined,
  overrides: Partial<AvailabilityDeps> = {},
): Promise<AllocationView> {
  const deps = resolveDeps(overrides);
  const now = deps.now();

  const existing = await deps.allocations.findById(ctx, allocationId);
  if (!existing) throw new AppError("NOT_FOUND", "Allocation not found");
  if (existing.status === "confirmed") return toAllocationView(existing);
  if (existing.status !== "held") {
    throw new AppError("CONFLICT", "Only a live hold can be confirmed");
  }
  if (existing.expiresAt && existing.expiresAt <= now) {
    throw new AppError("CONFLICT", "That hold has expired. Check availability again.");
  }

  const updated = await deps.allocations.updateOne(
    ctx,
    // The status guard makes this safe to retry and safe to race with a
    // release: whichever write lands first decides, the other finds nothing.
    { _id: new ObjectId(allocationId), status: "held" } as Filter<ResourceAllocationDoc>,
    {
      $set: {
        status: "confirmed",
        expiresAt: null,
        ...(holderId ? { holderId: new ObjectId(holderId) } : {}),
      },
    },
  );
  if (!updated) throw new AppError("CONFLICT", "That hold is no longer live");
  return toAllocationView(updated);
}

/**
 * Gives the capacity back. `released` for a hold the customer walked away
 * from, `cancelled` for a booking that was called off — the effect on
 * availability is identical, and the difference is what an operations log
 * needs to be able to say.
 */
export async function releaseAllocation(
  ctx: Ctx,
  allocationId: string,
  status: Extract<AllocationStatus, "released" | "cancelled"> = "released",
  overrides: Partial<AvailabilityDeps> = {},
): Promise<AllocationView> {
  const deps = resolveDeps(overrides);
  const existing = await deps.allocations.findById(ctx, allocationId);
  if (!existing) throw new AppError("NOT_FOUND", "Allocation not found");
  if (!BLOCKING_STATUSES.includes(existing.status)) return toAllocationView(existing);

  const updated = await deps.allocations.updateOne(
    ctx,
    {
      _id: new ObjectId(allocationId),
      status: { $in: [...BLOCKING_STATUSES] },
    } as Filter<ResourceAllocationDoc>,
    { $set: { status, expiresAt: null } },
  );
  if (!updated) throw new AppError("CONFLICT", "That allocation is no longer active");
  return toAllocationView(updated);
}

export const listAllocationsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.union([z.string(), z.number()]).optional(),
  poolId: objectIdHex.optional(),
  /** The timeline window. Both or neither — half a range is not a range. */
  from: isoDate.optional(),
  to: isoDate.optional(),
});

/**
 * What the master schedule (§2.3) reads. Filters on the *blocked* window, not
 * the booked one, so the timeline shows buffer blocks as the occupied time
 * they actually are.
 */
export async function listAllocations(
  ctx: Ctx,
  query: unknown,
  overrides: Partial<AvailabilityDeps> = {},
) {
  const deps = resolveDeps(overrides);
  const parsed = parse(listAllocationsQuerySchema, query, "query");

  const filter: Record<string, unknown> = {};
  if (parsed.poolId) filter.poolId = new ObjectId(parsed.poolId);
  if (parsed.from && parsed.to) {
    filter.blockedFrom = { $lt: parsed.to };
    filter.blockedUntil = { $gt: parsed.from };
  }

  const { items, meta } = await deps.allocations.listPage(ctx, {
    cursor: parsed.cursor,
    limit: clampLimit(parsed.limit),
    filter: filter as Filter<ResourceAllocationDoc>,
  });
  return { items: items.map(toAllocationView), meta };
}

/** Exported for the integration test, which needs a session to prove the guard. */
export type { ClientSession };
