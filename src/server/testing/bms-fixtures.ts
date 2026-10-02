/**
 * A small trading tenant for the read-side service tests: one "Orders" entity
 * whose records are what customers submitted, one booking form, and helpers to
 * add an order the way a submission would have raised it.
 */
import { ObjectId, type WithId } from "mongodb";
import { createContext, type Ctx } from "@/server/context";
import type { CustomerDeps, SubmissionDoc } from "@/server/services/customers";
import type { EntityDefDoc } from "@/server/services/entities";
import type { FormDoc } from "@/server/services/forms";
import type { OrderDoc, OrderStatus } from "@/server/services/orders";
import type { RecordDoc } from "@/server/services/records";
import { memoryRepository } from "./memory-repository";

export const TENANT = "000000000000000000000001";
export const OTHER_TENANT = "000000000000000000000002";
export const ENTITY_ID = new ObjectId("0000000000000000000000e1");
export const FORM_ID = new ObjectId("0000000000000000000000f1");

export const NOW = new Date("2026-06-15T12:00:00.000Z");
const DAY = 86_400_000;
export const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

export const ctxFor = (tenantId = TENANT, tier: Ctx["tier"] = "premium"): Ctx =>
  createContext({
    requestId: "req-bms-reads",
    tenantId,
    userId: "00000000000000000000000b",
    roles: ["owner"],
    tier,
  });

export type World = {
  orders: WithId<OrderDoc>[];
  records: WithId<RecordDoc>[];
  entities: WithId<EntityDefDoc>[];
  submissions: WithId<SubmissionDoc>[];
  forms: WithId<FormDoc>[];
};

let sequence = 0x1000;
/** Ascending ids, so "newest first" by `_id` follows insertion order. */
const nextId = () => new ObjectId((sequence += 1).toString(16).padStart(24, "0"));

export function emptyWorld(tenantId = TENANT): World {
  const tenant = new ObjectId(tenantId);
  return {
    orders: [],
    records: [],
    submissions: [],
    entities: [
      {
        _id: ENTITY_ID,
        tenantId: tenant,
        key: "shop_orders",
        name: "Shop orders",
        fields: [
          { key: "first_name", label: "First name", type: "text", required: true },
          { key: "last_name", label: "Last name", type: "text", required: false },
          { key: "email", label: "Email", type: "email", required: false },
          { key: "mobile", label: "Mobile", type: "phone", required: false },
          { key: "notes", label: "Anything else?", type: "text", required: false },
          { key: "gift", label: "Gift wrap", type: "checkbox", required: false },
          { key: "photo", label: "Photo", type: "image", required: false },
        ],
      } as unknown as WithId<EntityDefDoc>,
    ],
    forms: [
      {
        _id: FORM_ID,
        tenantId: tenant,
        entityDefId: ENTITY_ID,
        name: "Fruit box order",
      } as unknown as WithId<FormDoc>,
    ],
  };
}

export type OrderSeed = {
  tenantId?: string;
  data?: Record<string, unknown> | null;
  status?: OrderStatus;
  currency?: string;
  totalMinor?: number;
  paid?: { amountMinor: number; at: Date }[];
  createdAt?: Date;
  description?: string;
  quantity?: number;
  /** False drafts the order by hand: a customer record but no submission. */
  viaForm?: boolean;
};

/** Adds an order, the record behind its customer and (by default) the submission. */
export function addOrder(world: World, seed: OrderSeed = {}): WithId<OrderDoc> {
  const tenantId = new ObjectId(seed.tenantId ?? TENANT);
  const createdAt = seed.createdAt ?? NOW;
  const totalMinor = seed.totalMinor ?? 5_000;
  const payments = (seed.paid ?? []).map((payment) => ({ ...payment, reference: null }));

  let recordId: ObjectId | null = null;
  if (seed.data !== null) {
    recordId = nextId();
    world.records.push({
      _id: recordId,
      tenantId,
      entityDefId: ENTITY_ID,
      schemaVersion: 1,
      data: seed.data ?? {
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@example.test",
      },
      deletedAt: null,
      createdAt,
      updatedAt: createdAt,
    });
  }

  const order: WithId<OrderDoc> = {
    _id: nextId(),
    tenantId,
    customerRecordId: recordId,
    status: seed.status ?? "confirmed",
    currency: seed.currency ?? "EUR",
    lineItems: [
      {
        kind: "resource",
        description: seed.description ?? "Fruit box",
        quantity: seed.quantity ?? 1,
        unitAmountMinor: totalMinor,
        amountMinor: totalMinor,
      },
    ],
    subtotalMinor: totalMinor,
    discountMinor: 0,
    totalMinor,
    depositMinor: 0,
    amountPaidMinor: payments.reduce((sum, payment) => sum + payment.amountMinor, 0),
    payments,
    allocationIds: [],
    notes: null,
    confirmedAt: null,
    completedAt: null,
    cancelledAt: null,
    deletedAt: null,
    createdAt,
    updatedAt: payments.at(-1)?.at ?? createdAt,
  };
  world.orders.push(order);

  if (recordId && seed.viaForm !== false) {
    world.submissions.push({
      _id: nextId(),
      tenantId,
      formId: FORM_ID,
      recordId,
      selectedRecordId: null,
      orderId: order._id,
      allocationId: null,
      deletedAt: null,
      createdAt,
      updatedAt: createdAt,
    });
  }
  return order;
}

export const depsFor = (world: World): CustomerDeps => ({
  orders: memoryRepository<OrderDoc>("orders", world.orders),
  records: memoryRepository<RecordDoc>("records", world.records),
  entities: memoryRepository<EntityDefDoc>("entity_defs", world.entities),
  submissions: memoryRepository<SubmissionDoc>("form_submissions", world.submissions),
  forms: memoryRepository<FormDoc>("forms", world.forms),
});
