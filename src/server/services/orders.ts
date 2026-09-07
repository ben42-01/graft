/**
 * Orders — the state machine of docs/BMS_EXTENSION.md §2.2 and the thing that
 * ties a customer's booking to the capacity it reserved.
 *
 *   draft → pending_payment → confirmed → in_progress → completed
 *     └──────────────┴──────────────┴────────────┴──────→ cancelled
 *
 * Four things matter enough to call out:
 *
 *   - **The transition table is data, not `if` statements.** Every legal move
 *     is one entry in `TRANSITIONS`, so "can an order go from completed back
 *     to draft" has exactly one answer in exactly one place. An illegal move
 *     is a 409 naming both states rather than a silent no-op.
 *   - **Confirming an order confirms its allocations, and cancelling releases
 *     them.** An order that says "confirmed" while the boat it booked has
 *     quietly lapsed is the single worst failure this subsystem can have, so
 *     the two are moved together and the allocations are moved *first* — if
 *     capacity has been lost the order must not claim otherwise.
 *   - **Line items are a snapshot, priced once.** They are written onto the
 *     order at the moment it is drafted and never recomputed, so changing a
 *     boat's hourly rate does not silently re-price a confirmed booking. This
 *     is the same reasoning `forms` uses when it copies `FieldDef`s rather
 *     than referencing them.
 *   - **`amountPaidMinor` only ever goes up, and only through
 *     `recordPayment`.** Deposits and the balance are two payments against one
 *     order (§2.2's "Split & Deposit Payments"), so the order tracks a running
 *     total rather than a boolean, and the transition to `confirmed` is driven
 *     by whether that total has reached the deposit — not by a caller's
 *     opinion.
 */
import { ObjectId, type Filter } from "mongodb";
import { z } from "zod";
import type { Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import { clampLimit } from "@/server/http/pagination";
import { parse } from "@/server/http/validate";
import { createLogger } from "@/server/log";
import { createRepository, type Repository } from "@/server/repositories/base";
import {
  confirmAllocation as confirmAllocationDefault,
  releaseAllocation as releaseAllocationDefault,
  type AllocationView,
} from "./availability";
import {
  balanceMinor,
  currencySchema,
  depositFor,
  depositSchema,
  lineItemInputSchema,
  lineItemSchema,
  toLineItem,
  totalsFor,
  type LineItem,
} from "./pricing";

const objectIdHex = z.string().regex(/^[0-9a-f]{24}$/i, "Expected a 24-character id");

/** §2.2's transitions, in the codebase's lower-snake enum convention. */
export const ORDER_STATUSES = [
  "draft",
  "pending_payment",
  "confirmed",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * The whole state machine, as data. `cancelled` is reachable from everything
 * that has not already finished — a business cancels a job mid-hire more often
 * than any diagram admits — and nothing is reachable *from* a terminal state.
 */
export const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  draft: ["pending_payment", "confirmed", "cancelled"],
  pending_payment: ["confirmed", "cancelled"],
  confirmed: ["in_progress", "completed", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

/** Statuses in which the order still holds the capacity it reserved. */
export const ACTIVE_STATUSES: readonly OrderStatus[] = [
  "draft",
  "pending_payment",
  "confirmed",
  "in_progress",
];

export const canTransition = (from: OrderStatus, to: OrderStatus): boolean =>
  TRANSITIONS[from].includes(to);

export const createOrderSchema = z.object({
  /** The customer this is for — a record, like every other business object. */
  customerRecordId: objectIdHex.optional(),
  currency: currencySchema,
  /** Allocations this order takes over, typically holds from a checkout. */
  allocationIds: z.array(objectIdHex).max(50).default([]),
  lineItems: z.array(lineItemInputSchema).min(1).max(200),
  deposit: depositSchema.nullish(),
  notes: z.string().trim().max(2_000).optional(),
});

export const updateOrderSchema = z
  .object({
    lineItems: z.array(lineItemInputSchema).min(1).max(200).optional(),
    deposit: depositSchema.nullish(),
    notes: z.string().trim().max(2_000).optional(),
    customerRecordId: objectIdHex.optional(),
  })
  .refine((v) => Object.values(v).some((value) => value !== undefined), {
    message: "Nothing to update",
  });

export const transitionOrderSchema = z.object({ status: z.enum(ORDER_STATUSES) });

export const recordPaymentSchema = z.object({
  amountMinor: z.number().int().positive(),
  /** Free-form provider reference — a Stripe payment intent id, say. */
  reference: z.string().trim().max(200).optional(),
});

export const listOrdersQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.union([z.string(), z.number()]).optional(),
  status: z.enum(ORDER_STATUSES).optional(),
});

export const orderIdParamSchema = z.object({ orderId: objectIdHex });

export type CreateOrderInput = z.input<typeof createOrderSchema>;

export type OrderPayment = {
  amountMinor: number;
  reference: string | null;
  at: Date;
};

export type OrderDoc = {
  tenantId: ObjectId;
  customerRecordId: ObjectId | null;
  status: OrderStatus;
  currency: string;
  /** Priced once, at draft time. Never recomputed — see the module docs. */
  lineItems: LineItem[];
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  /** What must be paid before the order may be confirmed. 0 means all of it. */
  depositMinor: number;
  amountPaidMinor: number;
  payments: OrderPayment[];
  allocationIds: ObjectId[];
  notes: string | null;
  /** When the order reached each terminal-ish state; null until it does. */
  confirmedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type OrderView = {
  id: string;
  customerRecordId: string | null;
  status: OrderStatus;
  currency: string;
  lineItems: LineItem[];
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  depositMinor: number;
  amountPaidMinor: number;
  /** Derived, never stored — one fewer field that can disagree with itself. */
  balanceMinor: number;
  payments: OrderPayment[];
  allocationIds: string[];
  notes: string | null;
  confirmedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toOrderView(doc: OrderDoc & { _id: ObjectId }): OrderView {
  return {
    id: doc._id.toHexString(),
    customerRecordId: doc.customerRecordId ? doc.customerRecordId.toHexString() : null,
    status: doc.status,
    currency: doc.currency,
    lineItems: doc.lineItems,
    subtotalMinor: doc.subtotalMinor,
    discountMinor: doc.discountMinor,
    totalMinor: doc.totalMinor,
    depositMinor: doc.depositMinor,
    amountPaidMinor: doc.amountPaidMinor,
    balanceMinor: balanceMinor(doc.totalMinor, doc.amountPaidMinor),
    payments: doc.payments,
    allocationIds: doc.allocationIds.map((id) => id.toHexString()),
    notes: doc.notes,
    confirmedAt: doc.confirmedAt,
    completedAt: doc.completedAt,
    cancelledAt: doc.cancelledAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export type OrderDeps = {
  repo: Repository<OrderDoc>;
  confirmAllocation: (
    ctx: Ctx,
    allocationId: string,
    holderId: string | undefined,
  ) => Promise<AllocationView>;
  releaseAllocation: (
    ctx: Ctx,
    allocationId: string,
    status: "released" | "cancelled",
  ) => Promise<AllocationView>;
  now: () => Date;
};

const defaultRepo = createRepository<OrderDoc>("orders");

function resolveDeps(overrides: Partial<OrderDeps> = {}): OrderDeps {
  return {
    repo: overrides.repo ?? defaultRepo,
    confirmAllocation:
      overrides.confirmAllocation ??
      ((ctx, allocationId, holderId) => confirmAllocationDefault(ctx, allocationId, holderId)),
    releaseAllocation:
      overrides.releaseAllocation ??
      ((ctx, allocationId, status) => releaseAllocationDefault(ctx, allocationId, status)),
    now: overrides.now ?? (() => new Date()),
  };
}

async function orderOrThrow(deps: OrderDeps, ctx: Ctx, orderId: string) {
  const doc = await deps.repo.findById(ctx, orderId);
  if (!doc) throw new AppError("NOT_FOUND", "Order not found");
  return doc;
}

/** Prices the list once and returns both the items and what they come to. */
export function priceOrder(items: readonly z.input<typeof lineItemInputSchema>[]) {
  const lineItems = items.map(toLineItem);
  return { lineItems, ...totalsFor(lineItems) };
}

export async function createOrder(
  ctx: Ctx,
  input: unknown,
  overrides: Partial<OrderDeps> = {},
): Promise<OrderView> {
  const deps = resolveDeps(overrides);
  const parsed = parse(createOrderSchema, input, "body");
  const { lineItems, subtotalMinor, discountMinor, totalMinor } = priceOrder(parsed.lineItems);

  const doc = await deps.repo.insertOne(ctx, {
    customerRecordId: parsed.customerRecordId ? new ObjectId(parsed.customerRecordId) : null,
    status: "draft",
    currency: parsed.currency,
    lineItems,
    subtotalMinor,
    discountMinor,
    totalMinor,
    depositMinor: depositFor(totalMinor, parsed.deposit ?? null),
    amountPaidMinor: 0,
    payments: [],
    allocationIds: parsed.allocationIds.map((id) => new ObjectId(id)),
    notes: parsed.notes ?? null,
    confirmedAt: null,
    completedAt: null,
    cancelledAt: null,
    deletedAt: null,
  });
  return toOrderView(doc);
}

export async function listOrders(ctx: Ctx, query: unknown, overrides: Partial<OrderDeps> = {}) {
  const deps = resolveDeps(overrides);
  const parsed = parse(listOrdersQuerySchema, query, "query");
  const { items, meta } = await deps.repo.listPage(ctx, {
    cursor: parsed.cursor,
    limit: clampLimit(parsed.limit),
    filter: parsed.status ? ({ status: parsed.status } as Filter<OrderDoc>) : undefined,
  });
  return { items: items.map(toOrderView), meta };
}

export async function getOrder(
  ctx: Ctx,
  orderId: string,
  overrides: Partial<OrderDeps> = {},
): Promise<OrderView> {
  return toOrderView(await orderOrThrow(resolveDeps(overrides), ctx, orderId));
}

/**
 * Editable only while the order is still a draft. Once a customer has been
 * asked for money, the line items are what they agreed to; re-pricing them
 * underneath a `pending_payment` order would change the amount owed after the
 * fact.
 */
export async function updateOrder(
  ctx: Ctx,
  orderId: string,
  input: unknown,
  overrides: Partial<OrderDeps> = {},
): Promise<OrderView> {
  const deps = resolveDeps(overrides);
  const parsed = parse(updateOrderSchema, input, "body");
  const existing = await orderOrThrow(deps, ctx, orderId);

  if (existing.status !== "draft") {
    throw new AppError(
      "CONFLICT",
      "Only a draft order can be edited. Cancel it and raise a new one.",
    );
  }

  const repriced = parsed.lineItems ? priceOrder(parsed.lineItems) : null;
  const totalMinor = repriced ? repriced.totalMinor : existing.totalMinor;
  // A deposit is a share of the total, so re-pricing has to re-derive it even
  // when the caller said nothing about the deposit itself.
  const depositMinor =
    parsed.deposit !== undefined
      ? depositFor(totalMinor, parsed.deposit ?? null)
      : repriced
        ? Math.min(existing.depositMinor, totalMinor)
        : existing.depositMinor;

  const updated = await deps.repo.updateOne(
    ctx,
    { _id: new ObjectId(orderId) } as Filter<OrderDoc>,
    {
      $set: {
        ...(repriced
          ? {
              lineItems: repriced.lineItems,
              subtotalMinor: repriced.subtotalMinor,
              discountMinor: repriced.discountMinor,
              totalMinor: repriced.totalMinor,
            }
          : {}),
        depositMinor,
        ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
        ...(parsed.customerRecordId !== undefined
          ? { customerRecordId: new ObjectId(parsed.customerRecordId) }
          : {}),
      },
    },
  );
  if (!updated) throw new AppError("NOT_FOUND", "Order not found");
  return toOrderView(updated);
}

/**
 * The state machine's only door. Illegal moves are refused by name, and the
 * two transitions with consequences beyond the order itself — `confirmed` and
 * `cancelled` — carry their allocations with them.
 */
export async function transitionOrder(
  ctx: Ctx,
  orderId: string,
  input: unknown,
  overrides: Partial<OrderDeps> = {},
): Promise<OrderView> {
  const deps = resolveDeps(overrides);
  const { status: next } = parse(transitionOrderSchema, input, "body");
  const existing = await orderOrThrow(deps, ctx, orderId);

  if (existing.status === next) return toOrderView(existing);
  if (!canTransition(existing.status, next)) {
    throw new AppError("CONFLICT", `An order cannot go from ${existing.status} to ${next}`, {
      from: existing.status,
      to: next,
      allowed: TRANSITIONS[existing.status],
    });
  }

  const now = deps.now();

  // Allocations move *first*. If capacity has been lost — a hold lapsed while
  // the customer was paying — the order must fail to confirm rather than claim
  // a resource it no longer has.
  if (next === "confirmed") {
    for (const allocationId of existing.allocationIds) {
      await deps.confirmAllocation(ctx, allocationId.toHexString(), orderId);
    }
  }
  if (next === "cancelled") {
    for (const allocationId of existing.allocationIds) {
      // Best-effort: an allocation already released is not a reason to leave
      // the order stuck in a state the business has decided is over.
      await deps
        .releaseAllocation(ctx, allocationId.toHexString(), "cancelled")
        .catch((error: unknown) => {
          createLogger({ requestId: ctx.requestId }).warn("orders.release.skipped", {
            tenantId: ctx.tenantId,
            orderId,
            allocationId: allocationId.toHexString(),
            reason: error instanceof AppError ? error.code : "unknown",
          });
        });
    }
  }

  const updated = await deps.repo.updateOne(
    ctx,
    // The guard makes a double-submit safe: the second one finds nothing.
    { _id: new ObjectId(orderId), status: existing.status } as Filter<OrderDoc>,
    {
      $set: {
        status: next,
        ...(next === "confirmed" ? { confirmedAt: now } : {}),
        ...(next === "completed" ? { completedAt: now } : {}),
        ...(next === "cancelled" ? { cancelledAt: now } : {}),
      },
    },
  );
  if (!updated) throw new AppError("CONFLICT", "That order changed while you were working");
  return toOrderView(updated);
}

/**
 * Records money received against the order — a deposit, the balance, or a
 * partial (§2.2's "Split & Deposit Payments").
 *
 * The transition to `confirmed` is a *consequence* of the total reaching the
 * deposit, not something the caller asks for: a payment provider knows how
 * much arrived, and nothing more.
 */
export async function recordPayment(
  ctx: Ctx,
  orderId: string,
  input: unknown,
  overrides: Partial<OrderDeps> = {},
): Promise<OrderView> {
  const deps = resolveDeps(overrides);
  const parsed = parse(recordPaymentSchema, input, "body");
  const existing = await orderOrThrow(deps, ctx, orderId);

  if (!ACTIVE_STATUSES.includes(existing.status)) {
    throw new AppError("CONFLICT", `A ${existing.status} order cannot take a payment`);
  }

  const now = deps.now();
  const payment: OrderPayment = {
    amountMinor: parsed.amountMinor,
    reference: parsed.reference ?? null,
    at: now,
  };

  const updated = await deps.repo.updateOne(
    ctx,
    { _id: new ObjectId(orderId) } as Filter<OrderDoc>,
    // `$inc` and `$push`, not a read-modify-write: two payments landing at once
    // (a webhook retry beside a manual entry) must add up rather than one
    // overwriting the other's total.
    { $inc: { amountPaidMinor: parsed.amountMinor }, $push: { payments: payment } } as never,
  );
  if (!updated) throw new AppError("NOT_FOUND", "Order not found");

  // Enough has arrived to confirm, and the order has not been confirmed yet.
  const threshold = updated.depositMinor > 0 ? updated.depositMinor : updated.totalMinor;
  if (updated.amountPaidMinor >= threshold && canTransition(updated.status, "confirmed")) {
    return transitionOrder(ctx, orderId, { status: "confirmed" }, overrides);
  }

  return toOrderView(updated);
}

/**
 * Cancels and soft-deletes. There is no hard delete: an order is a financial
 * record, and the allocations it released are only explicable with it.
 */
export async function deleteOrder(
  ctx: Ctx,
  orderId: string,
  overrides: Partial<OrderDeps> = {},
): Promise<void> {
  const deps = resolveDeps(overrides);
  const existing = await orderOrThrow(deps, ctx, orderId);
  if (canTransition(existing.status, "cancelled")) {
    await transitionOrder(ctx, orderId, { status: "cancelled" }, overrides);
  }
  await deps.repo.softDelete(ctx, orderId);
}

export { lineItemSchema };
