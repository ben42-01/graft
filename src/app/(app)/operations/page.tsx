"use client";

/**
 * The Operational Command Dashboard of docs/BMS_EXTENSION.md §2.3 — the
 * pipeline, the master schedule and the day's dispatch, in one place.
 *
 * Three things matter enough to call out:
 *
 *   - **It is composed from endpoints that already exist.** Orders,
 *     allocations and pools are three plain reads; there is no bespoke
 *     `/dashboard` endpoint returning a shape only this screen understands.
 *     A view that needs its own server contract is a view that goes stale the
 *     first time anything else changes.
 *   - **Resource names come from records, resolved once.** An allocation
 *     carries a `recordId`, not a name, so the pools and their records are
 *     fetched alongside and joined here — which is also why the timeline shows
 *     "24ft Pontoon Boat" rather than an ObjectId.
 *   - **Today is the default window.** The dispatch panel is about today by
 *     definition, and a scheduler that opens on an arbitrary range makes the
 *     reader orient themselves before they can read anything.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CalendarRangeIcon, KanbanIcon, SunIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/shell/empty-state";
import { ErrorState } from "@/components/shell/error-state";
import { LoadingState } from "@/components/shell/loading-state";
import {
  OrderBoard,
  type BoardOrder,
  type OrderStatus,
} from "@/components/operations/order-board";
import {
  ResourceTimeline,
  type TimelineAllocation,
} from "@/components/operations/resource-timeline";
import { buildDispatch, DailyDispatch } from "@/components/operations/daily-dispatch";

type ApiOrder = {
  id: string;
  status: OrderStatus;
  currency: string;
  totalMinor: number;
  balanceMinor: number;
  customerRecordId: string | null;
  lineItems: { description: string }[];
  createdAt: string;
};

type ApiAllocation = {
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

type ApiPool = { id: string; recordId: string; entityId: string };

type Loaded = {
  orders: BoardOrder[];
  allocations: TimelineAllocation[];
};

type State = { status: "loading" } | { status: "error" } | ({ status: "ready" } & Loaded);

/** How wide the schedule opens. A week reads as a plan; a day reads as a list. */
const WINDOW_DAYS = 7;

async function getJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) return null;
  return ((await response.json()) as { data: T }).data;
}

export default function OperationsPage() {
  const [state, setState] = useState<State>({ status: "loading" });

  const window = useMemo(() => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    return { from, to: new Date(from.getTime() + WINDOW_DAYS * 86_400_000) };
  }, []);

  const load = useCallback(async () => {
    try {
      const [orders, allocations, pools] = await Promise.all([
        getJson<ApiOrder[]>("/api/v1/orders?limit=100"),
        getJson<ApiAllocation[]>(
          `/api/v1/inventory/allocations?limit=200&from=${window.from.toISOString()}&to=${window.to.toISOString()}`,
        ),
        getJson<ApiPool[]>("/api/v1/inventory/pools?limit=100"),
      ]);

      if (!orders || !allocations || !pools) {
        setState({ status: "error" });
        return;
      }

      // An allocation knows its record's id but not its name. Resolving the
      // names is one request per distinct entity, not one per allocation.
      const labels = await resolveRecordLabels(pools);

      setState({
        status: "ready",
        orders: orders.map(toBoardOrder),
        allocations: allocations.map((allocation) => ({
          ...allocation,
          resourceLabel: labels.get(allocation.recordId) ?? "Unnamed resource",
        })),
      });
    } catch {
      setState({ status: "error" });
    }
  }, [window]);

  useEffect(() => {
    void load();
  }, [load]);

  const move = useCallback(
    async (orderId: string, to: OrderStatus) => {
      const response = await fetch(`/api/v1/orders/${orderId}/transitions`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: to }),
      });
      if (!response.ok) return false;
      // Confirming an order confirms its allocations, so the schedule changed
      // too — reload rather than patch one card and let the timeline lie.
      await load();
      return true;
    },
    [load],
  );

  if (state.status === "loading") return <LoadingState label="Loading operations…" />;
  if (state.status === "error") {
    return <ErrorState description="We couldn't load your operations board." />;
  }

  const dispatch = buildDispatch(state.allocations, state.orders, new Date());
  const nothingYet = state.orders.length === 0 && state.allocations.length === 0;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Operations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Today&apos;s work, the order pipeline and what every resource is doing this week.
        </p>
      </div>

      {nothingYet ? (
        <EmptyState
          icon={KanbanIcon}
          title="Nothing to run yet"
          description="Once you have bookable resources and orders against them, this is where the day is managed."
          action={
            <Button asChild size="sm">
              <Link href="/entities">Set up a resource</Link>
            </Button>
          }
        />
      ) : (
        <Tabs defaultValue="today">
          <TabsList>
            <TabsTrigger value="today">
              <SunIcon className="size-4" aria-hidden /> Today
            </TabsTrigger>
            <TabsTrigger value="board">
              <KanbanIcon className="size-4" aria-hidden /> Pipeline
            </TabsTrigger>
            <TabsTrigger value="schedule">
              <CalendarRangeIcon className="size-4" aria-hidden /> Schedule
            </TabsTrigger>
          </TabsList>

          <TabsContent value="today" className="mt-4">
            <DailyDispatch dispatch={dispatch} />
          </TabsContent>

          <TabsContent value="board" className="mt-4">
            <OrderBoard orders={state.orders} onMove={move} />
          </TabsContent>

          <TabsContent value="schedule" className="mt-4">
            <ResourceTimeline
              allocations={state.allocations}
              from={window.from}
              to={window.to}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function toBoardOrder(order: ApiOrder): BoardOrder {
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
async function resolveRecordLabels(pools: ApiPool[]): Promise<Map<string, string>> {
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
