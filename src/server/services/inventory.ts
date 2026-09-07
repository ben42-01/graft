/**
 * Inventory pools — the "what can be booked, and how much of it" half of the
 * resource engine (docs/BMS_EXTENSION.md §2.1).
 *
 * The specification is written against a relational schema (`InventoryPool`
 * with an `entity_id` FK to `BusinessEntity`). Graft is document-oriented and
 * its data model has two layers where that spec has one, so the mapping is
 * worth stating plainly:
 *
 *   - an **`entity_def`** is a tenant-defined *schema* ("Rental Item");
 *   - a **`record`** is one instance of it ("24ft Pontoon Boat", "Kayaks").
 *
 * The spec's example pool is named "24ft Pontoon Boat" and carries an hourly
 * rate — that is an instance, not a schema. So **a pool attaches to a
 * record**, one pool per record, and `entityDefId` is denormalised onto the
 * pool so "every bookable thing of this type" is an indexed query rather than
 * a join Mongo will not do.
 *
 * Two other things matter enough to call out:
 *
 *   - **`totalQuantity` means something different per strategy, and the
 *     service normalises it rather than trusting the caller.** An individual
 *     asset is always exactly 1 — "Boat #4" cannot have a capacity of 7 — so
 *     the field is forced to 1 there instead of being validated and rejected.
 *   - **The buffer is stored on the pool, not on the booking.** It is a
 *     property of the resource (a boat needs 30 minutes of cleaning), and
 *     putting it on the allocation would let two bookings of the same boat
 *     disagree about how long it takes to clean.
 */
import { ObjectId, MongoServerError, type Filter } from "mongodb";
import { z } from "zod";
import type { Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import { clampLimit } from "@/server/http/pagination";
import { parse } from "@/server/http/validate";
import { createRepository, type Repository } from "@/server/repositories/base";
import { getRecord as getRecordDefault, type RecordView } from "./records";

const objectIdHex = z.string().regex(/^[0-9a-f]{24}$/i, "Expected a 24-character id");

/**
 * The three strategies of docs/BMS_EXTENSION.md §2.1, named in the codebase's
 * own lower-snake convention rather than the doc's SCREAMING_CASE (`FieldType`,
 * `Visibility`, `Meter` are all lower-snake; a second convention for one enum
 * would be noise).
 */
export const INVENTORY_STRATEGIES = [
  /** Uniquely identified units: "Boat #4", a vehicle VIN, a specific room. */
  "individual_asset",
  /** Aggregate capacity minus active allocations: kayak stock, tents. */
  "pooled_quantity",
  /** Maximum concurrent service capacity: consulting hours, tour guide slots. */
  "time_slot",
] as const;

export type InventoryStrategy = (typeof INVENTORY_STRATEGIES)[number];

/**
 * A day of cleaning between bookings is a configuration error, not a policy.
 * The cap is deliberately generous (a week) so a genuinely slow turnaround —
 * equipment sent away for servicing — is still expressible.
 */
export const MAX_BUFFER_MINUTES = 7 * 24 * 60;

/** Above this, a "pool" is a data-entry slip rather than a stock level. */
export const MAX_POOL_QUANTITY = 100_000;

export const createPoolSchema = z.object({
  /**
   * Both halves of the record's address, because that is how records are
   * addressed everywhere else (`/entities/:entityId/records/:recordId`). It
   * also makes the pair self-checking: a `recordId` that does not live under
   * this `entityId` is simply not found, so a mismatched pool cannot be
   * created by quoting two ids that each exist separately.
   */
  entityId: objectIdHex,
  recordId: objectIdHex,
  strategy: z.enum(INVENTORY_STRATEGIES),
  /** Ignored for `individual_asset`, which is always exactly 1. */
  totalQuantity: z.number().int().positive().max(MAX_POOL_QUANTITY).optional(),
  bufferMinutes: z.number().int().min(0).max(MAX_BUFFER_MINUTES).optional(),
  /** Whether a checkout flow may take a temporary hold (§2.1). */
  autoLockOnCheckout: z.boolean().optional(),
});

export const updatePoolSchema = z
  .object({
    totalQuantity: z.number().int().positive().max(MAX_POOL_QUANTITY).optional(),
    bufferMinutes: z.number().int().min(0).max(MAX_BUFFER_MINUTES).optional(),
    autoLockOnCheckout: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((value) => value !== undefined), {
    message: "Nothing to update",
  });

export const listPoolsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.union([z.string(), z.number()]).optional(),
  /** Narrow to the pools of one entity type — the scheduler's main query. */
  entityId: objectIdHex.optional(),
});

export const poolIdParamSchema = z.object({ poolId: objectIdHex });

export type CreatePoolInput = z.input<typeof createPoolSchema>;
export type UpdatePoolInput = z.input<typeof updatePoolSchema>;

export type InventoryPoolDoc = {
  tenantId: ObjectId;
  /** Denormalised from the record so "all pools of this type" is indexed. */
  entityDefId: ObjectId;
  /** The bookable thing itself. Unique per tenant — one pool per record. */
  recordId: ObjectId;
  strategy: InventoryStrategy;
  /** Always 1 for `individual_asset`; capacity for the other two. */
  totalQuantity: number;
  /** Cooldown applied to *both* ends of every allocation (§2.1). */
  bufferMinutes: number;
  autoLockOnCheckout: boolean;
  /**
   * Bumped inside every allocation transaction. It is not a version anyone
   * reads — it exists so two concurrent holds on the same pool write the same
   * document and one of them loses, which is the only thing preventing write
   * skew from double-booking a resource. See availability.ts's module docs.
   */
  allocationVersion: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type InventoryPoolView = {
  id: string;
  entityId: string;
  recordId: string;
  strategy: InventoryStrategy;
  totalQuantity: number;
  bufferMinutes: number;
  autoLockOnCheckout: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const DEFAULT_BUFFER_MINUTES = 0;

const isDuplicateKey = (error: unknown): boolean =>
  error instanceof MongoServerError && error.code === 11000;

export function toPoolView(doc: InventoryPoolDoc & { _id: ObjectId }): InventoryPoolView {
  return {
    id: doc._id.toHexString(),
    entityId: doc.entityDefId.toHexString(),
    recordId: doc.recordId.toHexString(),
    strategy: doc.strategy,
    totalQuantity: doc.totalQuantity,
    bufferMinutes: doc.bufferMinutes,
    autoLockOnCheckout: doc.autoLockOnCheckout,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * The one place the strategy/quantity relationship is decided. An individual
 * asset is normalised to 1 rather than rejected for declaring 7: the caller is
 * describing a specific boat, and "how many of this boat are there" is not a
 * question they should have had to answer.
 */
export function quantityFor(strategy: InventoryStrategy, requested?: number): number {
  if (strategy === "individual_asset") return 1;
  if (requested === undefined) {
    throw new AppError("VALIDATION_FAILED", "Invalid request body", {
      source: "body",
      fields: { totalQuantity: "Pooled and time-slot inventory needs a total quantity" },
    });
  }
  return requested;
}

export type InventoryDeps = {
  repo: Repository<InventoryPoolDoc>;
  getRecord: (ctx: Ctx, entityId: string, recordId: string) => Promise<RecordView>;
};

const defaultRepo = createRepository<InventoryPoolDoc>("inventory_pools");

function resolveDeps(overrides: Partial<InventoryDeps> = {}): InventoryDeps {
  return {
    repo: overrides.repo ?? defaultRepo,
    getRecord:
      overrides.getRecord ??
      ((ctx, entityId, recordId) => getRecordDefault(ctx, entityId, recordId)),
  };
}

/**
 * The record is fetched rather than trusted: it proves the resource exists and
 * belongs to this tenant (the repository scopes the lookup), and it is where
 * `entityDefId` comes from — a client-supplied one could point a pool at the
 * wrong entity type and silently corrupt every scheduler query built on it.
 */
export async function createPool(
  ctx: Ctx,
  input: unknown,
  overrides: Partial<InventoryDeps> = {},
): Promise<InventoryPoolView> {
  const deps = resolveDeps(overrides);
  const parsed = parse(createPoolSchema, input, "body");

  const record = await deps.getRecord(ctx, parsed.entityId, parsed.recordId);

  try {
    const doc = await deps.repo.insertOne(ctx, {
      entityDefId: new ObjectId(record.entityId),
      recordId: new ObjectId(parsed.recordId),
      strategy: parsed.strategy,
      totalQuantity: quantityFor(parsed.strategy, parsed.totalQuantity),
      bufferMinutes: parsed.bufferMinutes ?? DEFAULT_BUFFER_MINUTES,
      autoLockOnCheckout: parsed.autoLockOnCheckout ?? true,
      allocationVersion: 0,
      deletedAt: null,
    });
    return toPoolView(doc);
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError("CONFLICT", "That resource already has an inventory pool");
    }
    throw error;
  }
}

export async function listPools(
  ctx: Ctx,
  query: { cursor?: string; limit?: unknown; entityId?: string },
  overrides: Partial<InventoryDeps> = {},
) {
  const deps = resolveDeps(overrides);
  const { items, meta } = await deps.repo.listPage(ctx, {
    cursor: query.cursor,
    limit: clampLimit(query.limit),
    filter: query.entityId
      ? ({ entityDefId: new ObjectId(query.entityId) } as Filter<InventoryPoolDoc>)
      : undefined,
  });
  return { items: items.map(toPoolView), meta };
}

/** Another tenant's pool is 404, not 403 — the repository scoping decides it. */
export async function getPool(
  ctx: Ctx,
  poolId: string,
  overrides: Partial<InventoryDeps> = {},
): Promise<InventoryPoolView> {
  const deps = resolveDeps(overrides);
  const doc = await deps.repo.findById(ctx, poolId);
  if (!doc) throw new AppError("NOT_FOUND", "Inventory pool not found");
  return toPoolView(doc);
}

/** The pool document itself, for callers inside the engine (availability.ts). */
export async function findPoolDoc(
  ctx: Ctx,
  poolId: string,
  overrides: Partial<InventoryDeps> = {},
): Promise<(InventoryPoolDoc & { _id: ObjectId }) | null> {
  if (!ObjectId.isValid(poolId)) return null;
  return resolveDeps(overrides).repo.findById(ctx, poolId);
}

/**
 * `strategy` is not patchable. Changing it would silently reinterpret every
 * allocation already written against the pool — a pooled booking of 4 kayaks
 * has no meaning once the pool claims to be a single named asset — and there
 * is no migration that could be right for both readings. Deleting the pool and
 * creating the right one is the honest path.
 */
export async function updatePool(
  ctx: Ctx,
  poolId: string,
  input: unknown,
  overrides: Partial<InventoryDeps> = {},
): Promise<InventoryPoolView> {
  const deps = resolveDeps(overrides);
  const parsed = parse(updatePoolSchema, input, "body");
  const existing = await deps.repo.findById(ctx, poolId);
  if (!existing) throw new AppError("NOT_FOUND", "Inventory pool not found");

  if (parsed.totalQuantity !== undefined && existing.strategy === "individual_asset") {
    throw new AppError("VALIDATION_FAILED", "Invalid request body", {
      source: "body",
      fields: { totalQuantity: "An individually tracked asset is always a quantity of one" },
    });
  }

  const updated = await deps.repo.updateOne(
    ctx,
    { _id: new ObjectId(poolId) } as Filter<InventoryPoolDoc>,
    {
      $set: {
        ...(parsed.totalQuantity !== undefined ? { totalQuantity: parsed.totalQuantity } : {}),
        ...(parsed.bufferMinutes !== undefined ? { bufferMinutes: parsed.bufferMinutes } : {}),
        ...(parsed.autoLockOnCheckout !== undefined
          ? { autoLockOnCheckout: parsed.autoLockOnCheckout }
          : {}),
      },
    },
  );
  if (!updated) throw new AppError("NOT_FOUND", "Inventory pool not found");
  return toPoolView(updated);
}

/**
 * Soft-deletes the pool. Existing allocations are deliberately left alone:
 * they are the record of what actually happened, and a business that retires a
 * boat still needs last season's bookings to be readable.
 */
export async function deletePool(
  ctx: Ctx,
  poolId: string,
  overrides: Partial<InventoryDeps> = {},
): Promise<void> {
  const deps = resolveDeps(overrides);
  const deleted = await deps.repo.softDelete(ctx, poolId);
  if (!deleted) throw new AppError("NOT_FOUND", "Inventory pool not found");
}
