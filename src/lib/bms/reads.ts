"use client";

/**
 * The one client-side read of the operational layer, shared by the Operations
 * board and the default Overview.
 *
 * It lives here rather than in either screen because both need the same
 * awkward join — an allocation carries a `recordId`, not a resource name, so
 * the pools and their records have to be fetched alongside and stitched
 * together — and a second hand-rolled copy of that is a second thing to get
 * wrong. It stays a composition of endpoints that already exist: there is
 * still no bespoke `/overview` contract that goes stale the moment anything
 * else changes.
 *
 * Partial failure is a first-class result. The Overview shows several
 * independent things, and one refused read (a tier gate, a plugin the tenant
 * hasn't enabled) should cost the reader that panel, not the whole screen —
 * so every field is nullable and `ok` reports whether *anything* loaded.
 */
import type { BoardOrder, OrderStatus } from "@/components/operations/order-board";
import type { TimelineAllocation } from "@/components/operations/resource-timeline";

export type ApiOrder = {
  id: string;
  status: OrderStatus;
  currency: string;
  totalMinor: number;
  balanceMinor: number;
  customerRecordId: string | null;
  lineItems: { description: string }[];
  createdAt: string;
};

export type ApiAllocation = {
  id: string;
  poolId: string;
  recordId: string;
  startAt: string;
  endAt: string;
  blockedFrom: string;
  blockedUntil: string;
  quantity: number;
  status: TimelineAllocation["status"];
};

export type ApiPool = { id: string; recordId: string; entityId: string };

export async function getJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) return null;
    return ((await response.json()) as { data: T }).data;
  } catch {
    return null;
  }
}

export function toBoardOrder(order: ApiOrder): BoardOrder {
  const first = order.lineItems[0]?.description ?? "No items";
  const more = order.lineItems.length - 1;
  return {
    id: order.id,
    status: order.status,
    currency: order.currency,
    totalMinor: order.totalMinor,
    balanceMinor: order.balanceMinor,
    // The customer's *name* needs its record, which needs its entity; until a
    // customer is attached there is honestly nothing to show, and inventing a
    // placeholder id would be worse than saying so.
    customerLabel: order.customerRecordId ? "Customer" : null,
    lineSummary: more > 0 ? `${first} +${more} more` : first,
    createdAt: order.createdAt,
  };
}

/**
 * Record names for every pooled resource, fetched one entity at a time. Pools
 * cluster onto very few entity types (a rental business has "Rental Items",
 * not one entity per boat), so this is a handful of requests regardless of how
 * many resources there are.
 */
export async function resolveRecordLabels(pools: ApiPool[]): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const entityIds = [...new Set(pools.map((pool) => pool.entityId))];

  await Promise.all(
    entityIds.map(async (entityId) => {
      const records = await getJson<{ id: string; data: Record<string, unknown> }[]>(
        `/api/v1/entities/${entityId}/records?limit=100`,
      );
      for (const record of records ?? []) {
        const name = record.data.name ?? record.data.title ?? record.data.label;
        if (typeof name === "string" && name.trim() !== "") labels.set(record.id, name);
      }
    }),
  );

  return labels;
}

export type OperationsWindow = { from: Date; to: Date };

export type OperationsRead = {
  /** `null` means the read was refused or failed — distinct from "none yet". */
  orders: BoardOrder[] | null;
  allocations: TimelineAllocation[] | null;
  /** False only when *nothing* loaded, which is a screen-level error. */
  ok: boolean;
};

export async function loadOperations(window: OperationsWindow): Promise<OperationsRead> {
  const [orders, allocations, pools] = await Promise.all([
    getJson<ApiOrder[]>("/api/v1/orders?limit=100"),
    getJson<ApiAllocation[]>(
      `/api/v1/inventory/allocations?limit=200&from=${window.from.toISOString()}&to=${window.to.toISOString()}`,
    ),
    getJson<ApiPool[]>("/api/v1/inventory/pools?limit=100"),
  ]);

  const labels = pools ? await resolveRecordLabels(pools) : new Map<string, string>();

  return {
    orders: orders ? orders.map(toBoardOrder) : null,
    allocations: allocations
      ? allocations.map((allocation) => ({
          ...allocation,
          resourceLabel: labels.get(allocation.recordId) ?? "Unnamed resource",
        }))
      : null,
    ok: orders !== null || allocations !== null,
  };
}

/** A whole day from local midnight — the window every "today" panel reads. */
export function todayWindow(now: Date = new Date(), days = 1): OperationsWindow {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  return { from, to: new Date(from.getTime() + days * 86_400_000) };
}
