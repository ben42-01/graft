/**
 * Customers — who an order is for, resolved from data the tenant already has.
 *
 * Every order a form raises points at the record that submission became
 * (`customerRecordId`, booking-bridge.ts), and that record is where the name,
 * the email and everything else the form asked for actually live. Until this
 * module nothing read it back: the board said "Customer", the Overview said
 * nothing, and an owner looking at an order could not tell who had placed it.
 *
 * Four things matter enough to call out:
 *
 *   - **There is no customers collection.** A customer is derived — the
 *     orders that share a contact email, or failing that a single record. A
 *     stored copy would be a second source of truth about a person, and one
 *     that privacy deletion (`/account/privacy`) would have to remember to
 *     chase. Delete the record and the customer's details are gone from here
 *     too, with nothing left behind.
 *   - **Identity is read by field *type*, not by a magic key.** The email is
 *     the first `email` field, the phone the first `phone` field — both types
 *     the tenant chose in their own schema. Only the display name falls back
 *     to a heuristic (text fields that call themselves a name, then the first
 *     text field), and a wrong guess there mislabels a row rather than
 *     mispricing an order.
 *   - **A customer's id is one of their record ids.** Never the email: an
 *     address in a URL ends up in access logs and browser history. Any record
 *     id belonging to the customer resolves to the same person.
 *   - **The aggregate reads a bounded window.** `ORDER_WINDOW` most recent
 *     orders, grouped in memory. That is every order a small business has for
 *     years; a tenant past it gets recent customers rather than a slow page,
 *     and `truncated` says so instead of the totals quietly being short.
 */
import { ObjectId, type Filter, type WithId } from "mongodb";
import { z } from "zod";
import type { Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import { clampLimit } from "@/server/http/pagination";
import { parse } from "@/server/http/validate";
import { createRepository, type Repository } from "@/server/repositories/base";
import type { EntityDefDoc, FieldDef } from "./entities";
import type { FormDoc } from "./forms";
import { ACTIVE_STATUSES, toOrderView, type OrderDoc, type OrderView } from "./orders";
import { balanceMinor } from "./pricing";
import type { RecordDoc } from "./records";

const objectIdHex = z.string().regex(/^[0-9a-f]{24}$/i, "Expected a 24-character id");

/** How many of the newest orders the derived views read. See the module docs. */
export const ORDER_WINDOW = 5_000;

/** The slice of a `form_submissions` row these reads need. */
export type SubmissionDoc = {
  tenantId: ObjectId;
  formId: ObjectId;
  recordId: ObjectId;
  selectedRecordId: ObjectId | null;
  orderId: ObjectId | null;
  allocationId: ObjectId | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CustomerIdentity = {
  name: string | null;
  email: string | null;
  phone: string | null;
};

/** One answer the customer gave, labelled the way the tenant labelled it. */
export type CustomerAnswer = { key: string; label: string; type: string; value: string };

export type CustomerRef = CustomerIdentity & {
  /** The record carrying these details — and a valid `/customers/:id`. */
  recordId: string;
  entityId: string;
};

export type OrderSource = { formId: string; formName: string | null; submissionId: string };

export type OrderWithCustomer = OrderView & {
  /** Null when no customer was attached, or their record has been deleted. */
  customer: CustomerRef | null;
  /** The form submission that raised the order; null for one drafted by hand. */
  source: OrderSource | null;
};

export type CustomerMoney = {
  currency: string;
  /** Total of every order that was not cancelled. */
  bookedMinor: number;
  paidMinor: number;
  outstandingMinor: number;
};

export type CustomerSummary = CustomerIdentity & {
  id: string;
  entityId: string;
  recordIds: string[];
  orderCount: number;
  openOrderCount: number;
  money: CustomerMoney[];
  firstOrderAt: Date;
  lastOrderAt: Date;
};

export type CustomerDetail = CustomerSummary & {
  /** What they entered on their most recent submission. */
  answers: CustomerAnswer[];
  orders: OrderWithCustomer[];
};

export const listCustomersQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  sort: z.enum(["recent", "spend", "orders"]).optional().default("recent"),
  limit: z.union([z.string(), z.number()]).optional(),
});

export const customerIdParamSchema = z.object({ customerId: objectIdHex });

export type CustomerDeps = {
  orders: Repository<OrderDoc>;
  records: Repository<RecordDoc>;
  entities: Repository<EntityDefDoc>;
  submissions: Repository<SubmissionDoc>;
  forms: Repository<FormDoc>;
};

const defaults: CustomerDeps = {
  orders: createRepository<OrderDoc>("orders"),
  records: createRepository<RecordDoc>("records"),
  entities: createRepository<EntityDefDoc>("entity_defs"),
  submissions: createRepository<SubmissionDoc>("form_submissions"),
  forms: createRepository<FormDoc>("forms"),
};

export const resolveCustomerDeps = (overrides: Partial<CustomerDeps> = {}): CustomerDeps => ({
  ...defaults,
  ...overrides,
});

const text = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

const callsItselfAName = (field: FieldDef) =>
  /name/i.test(field.key) || /name/i.test(field.label);

/**
 * Who a record is, read off the tenant's own schema. See the module docs for
 * why the email and phone are found by type and only the name is guessed.
 */
export function customerIdentity(
  fields: readonly FieldDef[],
  data: Record<string, unknown>,
): CustomerIdentity {
  const first = (type: FieldDef["type"]) => {
    for (const field of fields) {
      if (field.type !== type) continue;
      const value = text(data[field.key]);
      if (value) return value;
    }
    return null;
  };

  const texts = fields.filter((field) => field.type === "text");
  // "First name" + "Last name" is the common shape, so up to two name-ish
  // fields are joined; a third is more likely a company than a person.
  const named = texts
    .filter(callsItselfAName)
    .map((field) => text(data[field.key]))
    .filter((value): value is string => value !== null)
    .slice(0, 2);

  return {
    name: named.length > 0 ? named.join(" ") : first("text"),
    email: first("email")?.toLowerCase() ?? null,
    phone: first("phone"),
  };
}

/** Every answer worth showing a human — media ids and blanks are left out. */
export function customerAnswers(
  fields: readonly FieldDef[],
  data: Record<string, unknown>,
): CustomerAnswer[] {
  const answers: CustomerAnswer[] = [];
  for (const field of fields) {
    if (field.type === "image" || field.type === "file") continue;
    const raw = data[field.key];
    if (raw === undefined || raw === null || raw === "") continue;
    const value =
      typeof raw === "boolean"
        ? raw
          ? "Yes"
          : "No"
        : typeof raw === "object"
          ? null
          : String(raw);
    if (value === null) continue;
    answers.push({ key: field.key, label: field.label, type: field.type, value });
  }
  return answers;
}

const unique = (ids: (ObjectId | null | undefined)[]): ObjectId[] => {
  const seen = new Map<string, ObjectId>();
  for (const id of ids) if (id) seen.set(id.toHexString(), id);
  return [...seen.values()];
};

const byIds = <T extends { _id: ObjectId }>(rows: T[]) =>
  new Map(rows.map((row) => [row._id.toHexString(), row]));

type Resolved = {
  record: WithId<RecordDoc>;
  fields: FieldDef[];
  ref: CustomerRef;
};

/** Record id → who that record is, for every id given, in two reads. */
async function resolveRecords(
  deps: CustomerDeps,
  ctx: Ctx,
  recordIds: ObjectId[],
): Promise<Map<string, Resolved>> {
  const out = new Map<string, Resolved>();
  if (recordIds.length === 0) return out;

  const records = await deps.records.find(ctx, {
    _id: { $in: recordIds },
  } as Filter<RecordDoc>);
  const entities = byIds(
    await deps.entities.find(ctx, {
      _id: { $in: unique(records.map((record) => record.entityDefId)) },
    } as Filter<EntityDefDoc>),
  );

  for (const record of records) {
    const fields = entities.get(record.entityDefId.toHexString())?.fields ?? [];
    out.set(record._id.toHexString(), {
      record,
      fields,
      ref: {
        recordId: record._id.toHexString(),
        entityId: record.entityDefId.toHexString(),
        ...customerIdentity(fields, record.data),
      },
    });
  }
  return out;
}

async function resolveSources(
  deps: CustomerDeps,
  ctx: Ctx,
  orderIds: ObjectId[],
): Promise<Map<string, OrderSource>> {
  const out = new Map<string, OrderSource>();
  if (orderIds.length === 0) return out;

  const submissions = await deps.submissions.find(ctx, {
    orderId: { $in: orderIds },
  } as Filter<SubmissionDoc>);
  const forms = byIds(
    await deps.forms.find(ctx, {
      _id: { $in: unique(submissions.map((submission) => submission.formId)) },
    } as Filter<FormDoc>),
  );

  for (const submission of submissions) {
    if (!submission.orderId) continue;
    out.set(submission.orderId.toHexString(), {
      formId: submission.formId.toHexString(),
      formName: forms.get(submission.formId.toHexString())?.name ?? null,
      submissionId: submission._id.toHexString(),
    });
  }
  return out;
}

/**
 * Attaches who each order is for and where it came from. Four reads however
 * many orders there are, so a page of 100 costs what a page of 1 does.
 */
export async function withCustomers(
  ctx: Ctx,
  orders: OrderView[],
  overrides: Partial<CustomerDeps> = {},
): Promise<OrderWithCustomer[]> {
  const deps = resolveCustomerDeps(overrides);
  const [customers, sources] = await Promise.all([
    resolveRecords(
      deps,
      ctx,
      unique(
        orders.map((order) =>
          order.customerRecordId ? new ObjectId(order.customerRecordId) : null,
        ),
      ),
    ),
    resolveSources(
      deps,
      ctx,
      orders.map((order) => new ObjectId(order.id)),
    ),
  ]);

  return orders.map((order) => ({
    ...order,
    customer: order.customerRecordId
      ? (customers.get(order.customerRecordId)?.ref ?? null)
      : null,
    source: sources.get(order.id) ?? null,
  }));
}

/** One order with its customer, plus the answers behind that customer. */
export async function orderWithCustomer(
  ctx: Ctx,
  order: OrderView,
  overrides: Partial<CustomerDeps> = {},
): Promise<OrderWithCustomer & { answers: CustomerAnswer[] }> {
  const deps = resolveCustomerDeps(overrides);
  const [enriched] = await withCustomers(ctx, [order], deps);
  const resolved = order.customerRecordId
    ? (await resolveRecords(deps, ctx, [new ObjectId(order.customerRecordId)])).get(
        order.customerRecordId,
      )
    : undefined;
  return {
    ...enriched,
    answers: resolved ? customerAnswers(resolved.fields, resolved.record.data) : [],
  };
}

const isOpen = (order: OrderView) => ACTIVE_STATUSES.includes(order.status);

/** The same person across orders: one email, or failing that one record. */
const groupKey = (ref: CustomerRef) =>
  ref.email ? `email:${ref.email}` : `record:${ref.recordId}`;

type Group = { key: string; refs: CustomerRef[]; orders: OrderView[] };

function summarise(group: Group): CustomerSummary {
  // Orders arrive newest first, so the first ref is the freshest details and
  // the last is the oldest record — the id that stays put as they reorder.
  const latest = group.refs[0];
  const oldest = group.refs[group.refs.length - 1];
  const money = new Map<string, CustomerMoney>();
  for (const order of group.orders) {
    if (order.status === "cancelled") continue;
    const line = money.get(order.currency) ?? {
      currency: order.currency,
      bookedMinor: 0,
      paidMinor: 0,
      outstandingMinor: 0,
    };
    line.bookedMinor += order.totalMinor;
    line.paidMinor += order.amountPaidMinor;
    line.outstandingMinor += balanceMinor(order.totalMinor, order.amountPaidMinor);
    money.set(order.currency, line);
  }

  return {
    id: oldest.recordId,
    entityId: latest.entityId,
    // Details change between orders; the freshest non-empty value wins.
    name: group.refs.find((ref) => ref.name)?.name ?? null,
    email: latest.email,
    phone: group.refs.find((ref) => ref.phone)?.phone ?? null,
    recordIds: [...new Set(group.refs.map((ref) => ref.recordId))],
    orderCount: group.orders.length,
    openOrderCount: group.orders.filter(isOpen).length,
    money: [...money.values()].sort((a, b) => b.bookedMinor - a.bookedMinor),
    firstOrderAt: group.orders[group.orders.length - 1].createdAt,
    lastOrderAt: group.orders[0].createdAt,
  };
}

/** Every customer in the order window, with the orders that make them one. */
export async function customerGroups(
  ctx: Ctx,
  overrides: Partial<CustomerDeps> = {},
): Promise<{ groups: Group[]; truncated: boolean }> {
  const deps = resolveCustomerDeps(overrides);
  const docs = await deps.orders.find(
    ctx,
    { customerRecordId: { $ne: null } } as Filter<OrderDoc>,
    { sort: { _id: -1 }, limit: ORDER_WINDOW },
  );
  const orders = docs.map(toOrderView);
  const resolved = await resolveRecords(
    deps,
    ctx,
    unique(docs.map((doc) => doc.customerRecordId)),
  );

  const groups = new Map<string, Group>();
  for (const order of orders) {
    const ref = resolved.get(order.customerRecordId!)?.ref;
    if (!ref) continue; // the record was deleted — nobody left to name
    const key = groupKey(ref);
    const group = groups.get(key) ?? { key, refs: [], orders: [] };
    group.refs.push(ref);
    group.orders.push(order);
    groups.set(key, group);
  }
  return { groups: [...groups.values()], truncated: docs.length >= ORDER_WINDOW };
}

const leadSpend = (customer: CustomerSummary) => customer.money[0]?.bookedMinor ?? 0;

export async function listCustomers(
  ctx: Ctx,
  query: unknown,
  overrides: Partial<CustomerDeps> = {},
): Promise<{
  items: CustomerSummary[];
  meta: { total: number; limit: number; truncated: boolean };
}> {
  const parsed = parse(listCustomersQuerySchema, query, "query");
  const limit = clampLimit(parsed.limit);
  const { groups, truncated } = await customerGroups(ctx, overrides);

  const needle = parsed.q?.toLowerCase();
  const matches = groups
    .map(summarise)
    .filter(
      (customer) =>
        !needle ||
        [customer.name, customer.email, customer.phone].some((value) =>
          value?.toLowerCase().includes(needle),
        ),
    );

  matches.sort((a, b) => {
    if (parsed.sort === "spend") return leadSpend(b) - leadSpend(a);
    if (parsed.sort === "orders") return b.orderCount - a.orderCount;
    return b.lastOrderAt.getTime() - a.lastOrderAt.getTime();
  });

  return {
    items: matches.slice(0, limit),
    meta: { total: matches.length, limit, truncated },
  };
}

/** How many of a customer's orders the profile carries. */
const PROFILE_ORDERS = 100;

export async function getCustomer(
  ctx: Ctx,
  customerId: string,
  overrides: Partial<CustomerDeps> = {},
): Promise<CustomerDetail> {
  const deps = resolveCustomerDeps(overrides);
  const { groups } = await customerGroups(ctx, deps);
  const group = groups.find((candidate) =>
    candidate.refs.some((ref) => ref.recordId === customerId),
  );
  // A record nobody ordered with is a record, not a customer — and a foreign
  // or unknown id lands here too, so existence is never leaked.
  if (!group) throw new AppError("NOT_FOUND", "Customer not found");

  const latest = (await resolveRecords(deps, ctx, [new ObjectId(group.refs[0].recordId)])).get(
    group.refs[0].recordId,
  );

  return {
    ...summarise(group),
    answers: latest ? customerAnswers(latest.fields, latest.record.data) : [],
    orders: await withCustomers(ctx, group.orders.slice(0, PROFILE_ORDERS), deps),
  };
}
