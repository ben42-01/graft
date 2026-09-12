"use client";

/**
 * The Operational Command Dashboard of docs/BMS_EXTENSION.md §2.3 — the
 * pipeline, the master schedule and the day's dispatch, in one place.
 *
 * Three things matter enough to call out:
 *
 *   - **It is composed from endpoints that already exist.** Orders,
 *     allocations and pools are three plain reads (`src/lib/bms/reads.ts`,
 *     shared with the Overview); there is no bespoke `/dashboard` endpoint
 *     returning a shape only this screen understands. A view that needs its
 *     own server contract is a view that goes stale the first time anything
 *     else changes.
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
import { loadOperations, todayWindow } from "@/lib/bms/reads";

type Loaded = {
  orders: BoardOrder[];
  allocations: TimelineAllocation[];
};

type State = { status: "loading" } | { status: "error" } | ({ status: "ready" } & Loaded);

/** How wide the schedule opens. A week reads as a plan; a day reads as a list. */
const WINDOW_DAYS = 7;

export default function OperationsPage() {
  const [state, setState] = useState<State>({ status: "loading" });

  const window = useMemo(() => todayWindow(new Date(), WINDOW_DAYS), []);

  const load = useCallback(async () => {
    const read = await loadOperations(window);
    // This screen *is* orders and allocations — unlike the Overview, there is
    // nothing left to show if neither loaded.
    if (!read.ok) {
      setState({ status: "error" });
      return;
    }
    setState({
      status: "ready",
      orders: read.orders ?? [],
      allocations: read.allocations ?? [],
    });
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
