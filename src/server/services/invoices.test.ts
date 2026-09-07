/**
 * Invoices — unit coverage (docs/BMS_EXTENSION.md §2.2).
 *
 * The properties worth pinning are the ones an auditor would ask about: that
 * an invoice is a snapshot rather than a live view of its order, that a
 * deposit and a balance invoice always sum to the order total, and that
 * numbering is sequential and gapless.
 */
import { ObjectId, type WithId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import type { Repository } from "@/server/repositories/base";
import {
  amountDueFor,
  formatInvoiceNumber,
  getInvoice,
  issueInvoice,
  ledgerForOrder,
  updateInvoiceStatus,
  type InvoiceDeps,
  type InvoiceDoc,
} from "./invoices";
import type { OrderView } from "./orders";
import type { LineItem } from "./pricing";

const TENANT = "000000000000000000000001";
const ORDER_ID = "000000000000000000000071";
const INVOICE_ID = "000000000000000000000081";

const NOW = new Date("2026-06-15T09:00:00.000Z");

const ctx: Ctx = createContext({
  requestId: "req-invoices",
  tenantId: TENANT,
  userId: "00000000000000000000000b",
  roles: ["owner"],
  tier: "free",
});

const LINE: LineItem = {
  kind: "resource",
  description: "24ft Pontoon Boat — 4 hours",
  quantity: 1,
  unitAmountMinor: 60_000,
  amountMinor: 60_000,
};

const order = (over: Partial<OrderView> = {}): OrderView => ({
  id: ORDER_ID,
  customerRecordId: null,
  status: "confirmed",
  currency: "EUR",
  lineItems: [LINE],
  subtotalMinor: 60_000,
  discountMinor: 0,
  totalMinor: 60_000,
  depositMinor: 18_000,
  amountPaidMinor: 0,
  balanceMinor: 60_000,
  payments: [],
  allocationIds: [],
  notes: null,
  confirmedAt: NOW,
  completedAt: null,
  cancelledAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const seedInvoice = (over: Partial<WithId<InvoiceDoc>> = {}): WithId<InvoiceDoc> => ({
  _id: new ObjectId(INVOICE_ID),
  tenantId: new ObjectId(TENANT),
  orderId: new ObjectId(ORDER_ID),
  number: "INV-2026-0001",
  kind: "full",
  status: "open",
  currency: "EUR",
  lineItems: [LINE],
  subtotalMinor: 60_000,
  discountMinor: 0,
  amountDueMinor: 60_000,
  orderTotalMinor: 60_000,
  notes: null,
  issuedAt: NOW,
  dueAt: new Date(NOW.getTime() + 14 * 86_400_000),
  paidAt: null,
  voidedAt: null,
  deletedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

function fakeRepo(seed: WithId<InvoiceDoc>[] = []) {
  const docs = new Map(seed.map((d) => [d._id.toHexString(), d]));
  const tenantId = new ObjectId(TENANT);

  const repo: Repository<InvoiceDoc> = {
    collectionName: "invoices",
    collection: vi.fn() as unknown as Repository<InvoiceDoc>["collection"],
    async find(_ctx, filter) {
      const f = (filter ?? {}) as Record<string, unknown> & {
        orderId?: ObjectId;
        kind?: string;
        status?: { $ne?: string };
      };
      return [...docs.values()].filter((d) => {
        if (d.deletedAt) return false;
        if (f.orderId && !d.orderId.equals(f.orderId)) return false;
        if (f.kind && d.kind !== f.kind) return false;
        if (f.status?.$ne && d.status === f.status.$ne) return false;
        return true;
      });
    },
    async findOne() {
      return null;
    },
    async findById(_ctx, id) {
      const found = docs.get(id.toString());
      return found && found.tenantId.equals(tenantId) && !found.deletedAt ? found : null;
    },
    async count() {
      return docs.size;
    },
    async insertOne(_ctx, doc) {
      const withId = {
        ...doc,
        tenantId,
        createdAt: NOW,
        updatedAt: NOW,
        _id: new ObjectId(),
      } as unknown as WithId<InvoiceDoc>;
      docs.set(withId._id.toHexString(), withId);
      return withId;
    },
    async updateOne(_ctx, filter, update) {
      const f = filter as Record<string, unknown>;
      const target = docs.get((f._id as ObjectId).toHexString());
      if (!target) return null;
      if (f.status !== undefined && target.status !== f.status) return null;
      const next = { ...target, ...(update.$set ?? {}) } as WithId<InvoiceDoc>;
      docs.set(next._id.toHexString(), next);
      return next;
    },
    async softDelete() {
      return true;
    },
    async listPage() {
      return { items: [...docs.values()], meta: { limit: 25, hasMore: false, cursor: null } };
    },
  };
  return { repo, docs };
}

/** A counter that behaves like the real one: monotonic, never repeating. */
function fakeNumbers(start = 0) {
  let seq = start;
  return { next: vi.fn(async () => ++seq) };
}

const deps = (
  seed: WithId<InvoiceDoc>[] = [],
  over: Partial<InvoiceDeps> = {},
): Partial<InvoiceDeps> => ({
  repo: fakeRepo(seed).repo,
  getOrder: async () => order(),
  numbers: fakeNumbers(),
  now: () => NOW,
  ...over,
});

describe("formatInvoiceNumber", () => {
  it("is year-scoped and zero-padded, so numbers sort as text", () => {
    expect(formatInvoiceNumber(2026, 1)).toBe("INV-2026-0001");
    expect(formatInvoiceNumber(2026, 42)).toBe("INV-2026-0042");
    expect(formatInvoiceNumber(2026, 12_345)).toBe("INV-2026-12345");
  });
});

describe("amountDueFor", () => {
  it("asks for the whole order on a full invoice", () => {
    expect(amountDueFor(order(), "full")).toBe(60_000);
  });

  it("splits deposit and balance so the two sum to the total", () => {
    const o = order({ depositMinor: 18_000, totalMinor: 60_000 });
    const deposit = amountDueFor(o, "deposit");
    const balance = amountDueFor(o, "balance");
    expect(deposit).toBe(18_000);
    expect(balance).toBe(42_000);
    expect(deposit + balance).toBe(o.totalMinor);
  });

  it("computes the balance from the deposit, not from what was actually paid", () => {
    // A part-paid deposit must not inflate the balance invoice above the
    // agreed price.
    const o = order({ depositMinor: 18_000, amountPaidMinor: 5_000 });
    expect(amountDueFor(o, "balance")).toBe(42_000);
  });

  it("refuses a deposit invoice on an order with no deposit", () => {
    expect(() => amountDueFor(order({ depositMinor: 0 }), "deposit")).toThrow();
  });
});

describe("issueInvoice", () => {
  it("snapshots the order and opens straight away", async () => {
    const d = deps();
    const invoice = await issueInvoice(ctx, { orderId: ORDER_ID, kind: "full" }, d);

    expect(invoice.status).toBe("open");
    expect(invoice.number).toBe("INV-2026-0001");
    expect(invoice.lineItems).toEqual([LINE]);
    expect(invoice.amountDueMinor).toBe(60_000);
    expect(invoice.orderTotalMinor).toBe(60_000);
    expect(invoice.currency).toBe("EUR");
  });

  it("does not change when the order changes afterwards — it is a snapshot", async () => {
    const live = { current: order() };
    const d = deps([], { getOrder: async () => live.current });
    const invoice = await issueInvoice(ctx, { orderId: ORDER_ID }, d);

    // The boat's rate doubles and the order is re-priced.
    live.current = order({ totalMinor: 120_000, subtotalMinor: 120_000 });

    const readBack = await getInvoice(ctx, invoice.id, d);
    expect(readBack.amountDueMinor).toBe(60_000);
  });

  it("numbers sequentially", async () => {
    const d = deps();
    const first = await issueInvoice(ctx, { orderId: ORDER_ID, kind: "deposit" }, d);
    const second = await issueInvoice(ctx, { orderId: ORDER_ID, kind: "balance" }, d);
    expect(first.number).toBe("INV-2026-0001");
    expect(second.number).toBe("INV-2026-0002");
  });

  it("defaults to a two-week due date", async () => {
    const d = deps();
    const invoice = await issueInvoice(ctx, { orderId: ORDER_ID }, d);
    expect(invoice.dueAt).toEqual(new Date(NOW.getTime() + 14 * 86_400_000));
  });

  it("honours an explicit due window, including due-on-receipt", async () => {
    const d = deps();
    const invoice = await issueInvoice(ctx, { orderId: ORDER_ID, dueInDays: 0 }, d);
    expect(invoice.dueAt).toEqual(NOW);
  });

  it("refuses a second live invoice of the same kind", async () => {
    const d = deps([seedInvoice({ kind: "full", status: "open" })]);
    await expect(
      issueInvoice(ctx, { orderId: ORDER_ID, kind: "full" }, d),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("allows a replacement once the first is void", async () => {
    const d = deps([seedInvoice({ kind: "full", status: "void" })]);
    const invoice = await issueInvoice(ctx, { orderId: ORDER_ID, kind: "full" }, d);
    expect(invoice.status).toBe("open");
  });

  it("allows a deposit and a balance invoice side by side", async () => {
    const d = deps([seedInvoice({ kind: "deposit", status: "open" })]);
    const invoice = await issueInvoice(ctx, { orderId: ORDER_ID, kind: "balance" }, d);
    expect(invoice.amountDueMinor).toBe(42_000);
  });

  it("refuses to invoice a cancelled order", async () => {
    const d = deps([], { getOrder: async () => order({ status: "cancelled" }) });
    await expect(issueInvoice(ctx, { orderId: ORDER_ID }, d)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("updateInvoiceStatus", () => {
  it("marks an open invoice paid, with a timestamp", async () => {
    const d = deps([seedInvoice()]);
    const invoice = await updateInvoiceStatus(ctx, INVOICE_ID, { status: "paid" }, d);
    expect(invoice.status).toBe("paid");
    expect(invoice.paidAt).toEqual(NOW);
  });

  it("voids an open invoice", async () => {
    const d = deps([seedInvoice()]);
    const invoice = await updateInvoiceStatus(ctx, INVOICE_ID, { status: "void" }, d);
    expect(invoice.status).toBe("void");
    expect(invoice.voidedAt).toEqual(NOW);
  });

  it("refuses to un-pay an invoice — a wrong one is voided and replaced", async () => {
    const d = deps([seedInvoice({ status: "paid", paidAt: NOW })]);
    await expect(
      updateInvoiceStatus(ctx, INVOICE_ID, { status: "void" }, d),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("is idempotent for the status it already has", async () => {
    const d = deps([seedInvoice({ status: "paid" })]);
    const invoice = await updateInvoiceStatus(ctx, INVOICE_ID, { status: "paid" }, d);
    expect(invoice.status).toBe("paid");
  });

  it("404s for another tenant's invoice", async () => {
    const d = deps([]);
    await expect(
      updateInvoiceStatus(ctx, INVOICE_ID, { status: "paid" }, d),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("ledgerForOrder", () => {
  it("sums what has been invoiced and what is still outstanding", async () => {
    const d = deps(
      [
        seedInvoice({ kind: "deposit", amountDueMinor: 18_000 }),
        seedInvoice({
          _id: new ObjectId("000000000000000000000082"),
          kind: "balance",
          number: "INV-2026-0002",
          amountDueMinor: 42_000,
        }),
      ],
      { getOrder: async () => order({ amountPaidMinor: 18_000 }) },
    );

    const ledger = await ledgerForOrder(ctx, ORDER_ID, d);
    expect(ledger.invoices).toHaveLength(2);
    expect(ledger.invoicedMinor).toBe(60_000);
    expect(ledger.outstandingMinor).toBe(42_000);
  });

  it("excludes void invoices from the invoiced total but still lists them", async () => {
    const d = deps([
      seedInvoice({ kind: "full", status: "void", amountDueMinor: 60_000 }),
      seedInvoice({
        _id: new ObjectId("000000000000000000000082"),
        kind: "full",
        number: "INV-2026-0002",
        amountDueMinor: 55_000,
      }),
    ]);

    const ledger = await ledgerForOrder(ctx, ORDER_ID, d);
    expect(ledger.invoices).toHaveLength(2);
    expect(ledger.invoicedMinor).toBe(55_000);
  });
});
