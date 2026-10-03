/**
 * The submissions inbox — everything that came in through a form, newest
 * first, with who sent it and what it turned into.
 *
 * A submission has always written three things (a record, a `form_submissions`
 * row and, on a booking form, an order) and the product has only ever shown
 * the first, buried in an entity's record list. An owner who wanted to know
 * "what came in today" had to know which entity to open. This is that answer
 * as one read: the form it came through, the person, and the order it raised.
 *
 * It is a join over rows that already exist, never a copy — the customer's
 * details are read off their record at request time, so deleting the record
 * leaves the inbox row with nobody named on it.
 */
import { ObjectId, type Filter } from "mongodb";
import { z } from "zod";
import type { Ctx } from "@/server/context";
import { clampLimit } from "@/server/http/pagination";
import { parse } from "@/server/http/validate";
import {
  customerIdentity,
  resolveCustomerDeps,
  type CustomerDeps,
  type CustomerRef,
  type SubmissionDoc,
} from "./customers";
import type { EntityDefDoc } from "./entities";
import type { FormDoc } from "./forms";
import { toOrderView, type OrderDoc, type OrderStatus } from "./orders";
import type { RecordDoc } from "./records";

const objectIdHex = z.string().regex(/^[0-9a-f]{24}$/i, "Expected a 24-character id");

export const listSubmissionsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.union([z.string(), z.number()]).optional(),
  formId: objectIdHex.optional(),
});

export type SubmissionView = {
  id: string;
  createdAt: Date;
  form: { id: string; name: string | null };
  /** The record this submission became. */
  recordId: string;
  /** Null when that record has since been deleted. */
  customer: CustomerRef | null;
  /** The order it raised — null on a form that takes no bookings. */
  order: {
    id: string;
    status: OrderStatus;
    currency: string;
    totalMinor: number;
    balanceMinor: number;
  } | null;
};

const idsOf = <T>(rows: T[], pick: (row: T) => ObjectId | null): ObjectId[] => {
  const seen = new Map<string, ObjectId>();
  for (const row of rows) {
    const id = pick(row);
    if (id) seen.set(id.toHexString(), id);
  }
  return [...seen.values()];
};

const keyed = <T extends { _id: ObjectId }>(rows: T[]) =>
  new Map(rows.map((row) => [row._id.toHexString(), row]));

export async function listSubmissions(
  ctx: Ctx,
  query: unknown,
  overrides: Partial<CustomerDeps> = {},
) {
  const deps = resolveCustomerDeps(overrides);
  const parsed = parse(listSubmissionsQuerySchema, query, "query");

  const { items, meta } = await deps.submissions.listPage(ctx, {
    cursor: parsed.cursor,
    limit: clampLimit(parsed.limit),
    filter: parsed.formId
      ? ({ formId: new ObjectId(parsed.formId) } as Filter<SubmissionDoc>)
      : undefined,
  });

  const [forms, records, orders] = await Promise.all([
    deps.forms.find(ctx, {
      _id: { $in: idsOf(items, (row) => row.formId) },
    } as Filter<FormDoc>),
    deps.records.find(ctx, {
      _id: { $in: idsOf(items, (row) => row.recordId) },
    } as Filter<RecordDoc>),
    deps.orders.find(ctx, {
      _id: { $in: idsOf(items, (row) => row.orderId) },
    } as Filter<OrderDoc>),
  ]);
  const entities = keyed(
    await deps.entities.find(ctx, {
      _id: { $in: idsOf(records, (record) => record.entityDefId) },
    } as Filter<EntityDefDoc>),
  );
  const formsById = keyed(forms);
  const recordsById = keyed(records);
  const ordersById = keyed(orders);

  const views: SubmissionView[] = items.map((row) => {
    const record = recordsById.get(row.recordId.toHexString());
    const order = row.orderId ? ordersById.get(row.orderId.toHexString()) : undefined;
    const view = order ? toOrderView(order) : null;
    return {
      id: row._id.toHexString(),
      createdAt: row.createdAt,
      form: {
        id: row.formId.toHexString(),
        name: formsById.get(row.formId.toHexString())?.name ?? null,
      },
      recordId: row.recordId.toHexString(),
      customer: record
        ? {
            recordId: record._id.toHexString(),
            entityId: record.entityDefId.toHexString(),
            ...customerIdentity(
              entities.get(record.entityDefId.toHexString())?.fields ?? [],
              record.data,
            ),
          }
        : null,
      order: view
        ? {
            id: view.id,
            status: view.status,
            currency: view.currency,
            totalMinor: view.totalMinor,
            balanceMinor: view.balanceMinor,
          }
        : null,
    };
  });

  return { items: views, meta };
}
