/**
 * Invoices — the document an order produces (docs/BMS_EXTENSION.md §2.2,
 * "Dynamic Invoice Generation").
 *
 * Four things matter enough to call out:
 *
 *   - **An invoice is a snapshot, not a view of its order.** It copies the line
 *     items, totals and currency at issue time. That is the whole point of the
 *     document: what the customer was asked to pay, on the day they were asked.
 *     Rendering it from the live order would let a later edit rewrite a
 *     document someone has already received.
 *   - **Numbers are per tenant, sequential and gapless.** `INV-2026-0001`. A
 *     gap in an invoice sequence is a question from an auditor, so the number
 *     is allocated with an atomic `findOneAndUpdate` on a per-tenant counter
 *     rather than by counting existing rows — counting races, and a soft-
 *     deleted invoice would make it count wrong anyway.
 *   - **A deposit invoice and a balance invoice are both invoices.** §2.2 asks
 *     for split payments, so `kind` distinguishes them and an order may have
 *     several. Their amounts are computed from the order's deposit, so two
 *     invoices against one order always sum to its total.
 *   - **`void` is the only way back.** An issued invoice is never edited and
 *     never deleted; a wrong one is voided and replaced, which is what leaves
 *     the trail an accountant expects.
 */
import { ObjectId, MongoServerError, type Filter } from "mongodb";
import { z } from "zod";
import type { Ctx } from "@/server/context";
import { getDb } from "@/server/db/mongo";
import { AppError } from "@/server/http/envelope";
import { clampLimit } from "@/server/http/pagination";
import { parse } from "@/server/http/validate";
import { createRepository, type Repository } from "@/server/repositories/base";
import { getOrder as getOrderDefault, type OrderView } from "./orders";
import { balanceMinor, type LineItem } from "./pricing";

const objectIdHex = z.string().regex(/^[0-9a-f]{24}$/i, "Expected a 24-character id");

export const INVOICE_STATUSES = ["draft", "open", "paid", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * `deposit` and `balance` are the two halves of a split payment; `full` is the
 * ordinary single invoice for an order with no deposit.
 */
export const INVOICE_KINDS = ["full", "deposit", "balance"] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

/** Long enough to chase, short enough to still mean something. */
export const DEFAULT_DUE_DAYS = 14;

export const issueInvoiceSchema = z.object({
  orderId: objectIdHex,
  kind: z.enum(INVOICE_KINDS).default("full"),
  dueInDays: z.number().int().min(0).max(365).optional(),
  notes: z.string().trim().max(2_000).optional(),
});

export const listInvoicesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.union([z.string(), z.number()]).optional(),
  orderId: objectIdHex.optional(),
  status: z.enum(INVOICE_STATUSES).optional(),
});

export const invoiceIdParamSchema = z.object({ invoiceId: objectIdHex });

export const updateInvoiceSchema = z.object({
  status: z.enum(["paid", "void"]),
});

export type InvoiceDoc = {
  tenantId: ObjectId;
  orderId: ObjectId;
  /** `INV-<year>-<0001>`, unique per tenant. */
  number: string;
  kind: InvoiceKind;
  status: InvoiceStatus;
  currency: string;
  /** Copied from the order at issue time — never re-read. */
  lineItems: LineItem[];
  subtotalMinor: number;
  discountMinor: number;
  /** What *this* invoice asks for: the deposit, the balance, or the lot. */
  amountDueMinor: number;
  /** The order's full total, for context on the document. */
  orderTotalMinor: number;
  notes: string | null;
  issuedAt: Date;
  dueAt: Date;
  paidAt: Date | null;
  voidedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type InvoiceView = {
  id: string;
  orderId: string;
  number: string;
  kind: InvoiceKind;
  status: InvoiceStatus;
  currency: string;
  lineItems: LineItem[];
  subtotalMinor: number;
  discountMinor: number;
  amountDueMinor: number;
  orderTotalMinor: number;
  notes: string | null;
  issuedAt: Date;
  dueAt: Date;
  paidAt: Date | null;
  voidedAt: Date | null;
};

export function toInvoiceView(doc: InvoiceDoc & { _id: ObjectId }): InvoiceView {
  return {
    id: doc._id.toHexString(),
    orderId: doc.orderId.toHexString(),
    number: doc.number,
    kind: doc.kind,
    status: doc.status,
    currency: doc.currency,
    lineItems: doc.lineItems,
    subtotalMinor: doc.subtotalMinor,
    discountMinor: doc.discountMinor,
    amountDueMinor: doc.amountDueMinor,
    orderTotalMinor: doc.orderTotalMinor,
    notes: doc.notes,
    issuedAt: doc.issuedAt,
    dueAt: doc.dueAt,
    paidAt: doc.paidAt,
    voidedAt: doc.voidedAt,
  };
}

/**
 * What this invoice asks for, given the order and which half it is.
 *
 * `balance` is the total minus the deposit rather than minus what has actually
 * been paid: the two documents must sum to the order regardless of whether the
 * deposit invoice was settled, otherwise a partly-paid deposit would quietly
 * inflate the balance invoice above the agreed price.
 */
export function amountDueFor(order: OrderView, kind: InvoiceKind): number {
  if (kind === "deposit") {
    if (order.depositMinor <= 0) {
      throw new AppError("CONFLICT", "This order has no deposit to invoice");
    }
    return order.depositMinor;
  }
  if (kind === "balance") return Math.max(0, order.totalMinor - order.depositMinor);
  return order.totalMinor;
}

export type InvoiceNumberStore = {
  /** Atomically claims the next number for `year`. Never returns a duplicate. */
  next(ctx: Ctx, year: number): Promise<number>;
};

/**
 * The counter is a document per tenant per year, `$inc`'d with an upsert — the
 * same guarded-increment shape `usage_meters` uses. Counting existing invoices
 * instead would race, and would skip a number as soon as one was voided.
 */
export function mongoInvoiceNumberStore(): InvoiceNumberStore {
  return {
    async next(ctx, year) {
      const db = await getDb();
      const result = await db
        .collection<{ tenantId: ObjectId; year: number; seq: number }>("invoice_counters")
        .findOneAndUpdate(
          { tenantId: new ObjectId(ctx.tenantId), year },
          { $inc: { seq: 1 } },
          { upsert: true, returnDocument: "after" },
        );
      if (!result) throw new AppError("INTERNAL", "Could not allocate an invoice number");
      return result.seq;
    },
  };
}

export const formatInvoiceNumber = (year: number, seq: number): string =>
  `INV-${year}-${seq.toString().padStart(4, "0")}`;

export type InvoiceDeps = {
  repo: Repository<InvoiceDoc>;
  getOrder: (ctx: Ctx, orderId: string) => Promise<OrderView>;
  numbers: InvoiceNumberStore;
  now: () => Date;
};

const defaultRepo = createRepository<InvoiceDoc>("invoices");

function resolveDeps(overrides: Partial<InvoiceDeps> = {}): InvoiceDeps {
  return {
    repo: overrides.repo ?? defaultRepo,
    getOrder: overrides.getOrder ?? ((ctx, orderId) => getOrderDefault(ctx, orderId)),
    numbers: overrides.numbers ?? mongoInvoiceNumberStore(),
    now: overrides.now ?? (() => new Date()),
  };
}

const isDuplicateKey = (error: unknown): boolean =>
  error instanceof MongoServerError && error.code === 11000;

/**
 * Issues an invoice against an order. Straight to `open` rather than `draft`:
 * the order *is* the draft, and a second drafting stage would be a document
 * nobody edits and everybody has to remember to send.
 */
export async function issueInvoice(
  ctx: Ctx,
  input: unknown,
  overrides: Partial<InvoiceDeps> = {},
): Promise<InvoiceView> {
  const deps = resolveDeps(overrides);
  const parsed = parse(issueInvoiceSchema, input, "body");

  // Tenant-scoped by the order service, so an order from elsewhere 404s here.
  const order = await deps.getOrder(ctx, parsed.orderId);
  if (order.status === "cancelled") {
    throw new AppError("CONFLICT", "A cancelled order cannot be invoiced");
  }

  const existing = await deps.repo.find(ctx, {
    orderId: new ObjectId(parsed.orderId),
    kind: parsed.kind,
    status: { $ne: "void" },
  } as Filter<InvoiceDoc>);
  if (existing.length > 0) {
    throw new AppError(
      "CONFLICT",
      `This order already has a live ${parsed.kind} invoice (${existing[0].number}). Void it first.`,
    );
  }

  const now = deps.now();
  const year = now.getUTCFullYear();
  const seq = await deps.numbers.next(ctx, year);
  const dueAt = new Date(now.getTime() + (parsed.dueInDays ?? DEFAULT_DUE_DAYS) * 86_400_000);

  try {
    const doc = await deps.repo.insertOne(ctx, {
      orderId: new ObjectId(parsed.orderId),
      number: formatInvoiceNumber(year, seq),
      kind: parsed.kind,
      status: "open",
      currency: order.currency,
      lineItems: order.lineItems,
      subtotalMinor: order.subtotalMinor,
      discountMinor: order.discountMinor,
      amountDueMinor: amountDueFor(order, parsed.kind),
      orderTotalMinor: order.totalMinor,
      notes: parsed.notes ?? null,
      issuedAt: now,
      dueAt,
      paidAt: null,
      voidedAt: null,
      deletedAt: null,
    });
    return toInvoiceView(doc);
  } catch (error) {
    if (isDuplicateKey(error)) {
      // The unique index on (tenantId, number) caught a number the counter
      // should have made impossible — worth a loud failure, not a retry loop.
      throw new AppError("CONFLICT", "That invoice number is already in use");
    }
    throw error;
  }
}

export async function listInvoices(
  ctx: Ctx,
  query: unknown,
  overrides: Partial<InvoiceDeps> = {},
) {
  const deps = resolveDeps(overrides);
  const parsed = parse(listInvoicesQuerySchema, query, "query");
  const filter: Record<string, unknown> = {};
  if (parsed.orderId) filter.orderId = new ObjectId(parsed.orderId);
  if (parsed.status) filter.status = parsed.status;

  const { items, meta } = await deps.repo.listPage(ctx, {
    cursor: parsed.cursor,
    limit: clampLimit(parsed.limit),
    filter: filter as Filter<InvoiceDoc>,
  });
  return { items: items.map(toInvoiceView), meta };
}

export async function getInvoice(
  ctx: Ctx,
  invoiceId: string,
  overrides: Partial<InvoiceDeps> = {},
): Promise<InvoiceView> {
  const deps = resolveDeps(overrides);
  const doc = await deps.repo.findById(ctx, invoiceId);
  if (!doc) throw new AppError("NOT_FOUND", "Invoice not found");
  return toInvoiceView(doc);
}

/**
 * The only two moves an issued invoice has. There is no edit and no delete —
 * a wrong invoice is voided and replaced, which is what leaves a trail.
 */
export async function updateInvoiceStatus(
  ctx: Ctx,
  invoiceId: string,
  input: unknown,
  overrides: Partial<InvoiceDeps> = {},
): Promise<InvoiceView> {
  const deps = resolveDeps(overrides);
  const { status } = parse(updateInvoiceSchema, input, "body");
  const existing = await deps.repo.findById(ctx, invoiceId);
  if (!existing) throw new AppError("NOT_FOUND", "Invoice not found");
  if (existing.status === status) return toInvoiceView(existing);
  if (existing.status !== "open") {
    throw new AppError("CONFLICT", `A ${existing.status} invoice cannot be changed`);
  }

  const now = deps.now();
  const updated = await deps.repo.updateOne(
    ctx,
    { _id: new ObjectId(invoiceId), status: "open" } as Filter<InvoiceDoc>,
    {
      $set: {
        status,
        ...(status === "paid" ? { paidAt: now } : { voidedAt: now }),
      },
    },
  );
  if (!updated) throw new AppError("CONFLICT", "That invoice changed while you were working");
  return toInvoiceView(updated);
}

/**
 * The ledger line for one order: every invoice against it and what is still
 * outstanding. Read by the dashboard (§2.3's "Invoicing & Ledger").
 */
export async function ledgerForOrder(
  ctx: Ctx,
  orderId: string,
  overrides: Partial<InvoiceDeps> = {},
): Promise<{
  order: OrderView;
  invoices: InvoiceView[];
  invoicedMinor: number;
  outstandingMinor: number;
}> {
  const deps = resolveDeps(overrides);
  const order = await deps.getOrder(ctx, orderId);
  const rows = await deps.repo.find(ctx, {
    orderId: new ObjectId(orderId),
  } as Filter<InvoiceDoc>);
  const invoices = rows.map(toInvoiceView);

  // Void invoices ask for nothing, so they are excluded from both figures.
  const live = invoices.filter((invoice) => invoice.status !== "void");
  return {
    order,
    invoices,
    invoicedMinor: live.reduce((total, invoice) => total + invoice.amountDueMinor, 0),
    outstandingMinor: balanceMinor(order.totalMinor, order.amountPaidMinor),
  };
}
