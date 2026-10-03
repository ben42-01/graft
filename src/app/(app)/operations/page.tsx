"use client";

/**
 * The Operational Command Dashboard of docs/BMS_EXTENSION.md §2.3 — the
 * day's dispatch, every order and customer, the inbox, the pipeline and the
 * master schedule, in one place.
 *
 * Four things matter enough to call out:
 *
 *   - **An order is a person, not a card.** Every row and card names who it
 *     is for and opens onto the order (`/operations/orders/:id`) or the
 *     customer (`/operations/customers/:id`). Before this the board could say
 *     only "Customer", and an owner had no way to tell who had ordered. *
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
import {
  CalendarRangeIcon,
  InboxIcon,
  KanbanIcon,
  ListIcon,
  PlusIcon,
  SunIcon,
  UsersIcon,
} from "lucide-react";
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
import { CustomersPanel } from "@/components/operations/customers-panel";
import { OrdersTable } from "@/components/operations/orders-table";
import { SubmissionsInbox } from "@/components/operations/submissions-inbox";
import { loadOperations, todayWindow } from "@/lib/bms/reads";

type Loaded = {
  orders: BoardOrder[];
  allocations: TimelineAllocation[];
};

type State = { status: "loading" } | { status: "error" } | ({ status: "ready" } & Loaded);

/** How wide the schedule opens. A week reads as a plan; a day reads as a list. */
const WINDOW_DAYS = 7;

/**
 * The views, in the order they are used through a day: what is happening,
 * what came in, who it is for, then the planning views.
 */
const TABS = ["today", "orders", "customers", "inbox", "board", "schedule"] as const;
type Tab = (typeof TABS)[number];

const isTab = (value: string | null): value is Tab => TABS.includes(value as Tab);

export default function OperationsPage() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [tab, setTab] = useState<Tab>("today");

  // The tab lives in the URL (`?tab=orders`) so the Overview can link straight
  // to a view and "back" from an order returns to the list it came from. Read
  // off `location` rather than `useSearchParams`, which would force the whole
  // screen behind a Suspense boundary for one query parameter.
  useEffect(() => {
    const requested = new URLSearchParams(globalThis.location.search).get("tab");
    if (isTab(requested)) setTab(requested);
  }, []);

  const selectTab = useCallback((next: string) => {
    if (!isTab(next)) return;
    setTab(next);
    const url = new URL(globalThis.location.href);
    if (next === "today") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    globalThis.history.replaceState(null, "", url);
  }, []);

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

  if (state.status === "loading")
    return <LoadingState label="Loading operations…" variant="page" />;
  if (state.status === "error") {
    return <ErrorState description="We couldn't load your operations board." />;
  }

  const dispatch = buildDispatch(state.allocations, state.orders, new Date());
  const nothingYet = state.orders.length === 0 && state.allocations.length === 0;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Operations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Today&apos;s work, every order and customer, and what each resource is doing this
            week.
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/operations/orders/new">
            <PlusIcon /> New order
          </Link>
        </Button>
      </div>

      <Tabs value={tab} onValueChange={selectTab}>
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList>
            <TabsTrigger value="today">
              <SunIcon className="size-4" aria-hidden /> Today
            </TabsTrigger>
            <TabsTrigger value="orders">
              <ListIcon className="size-4" aria-hidden /> Orders
            </TabsTrigger>
            <TabsTrigger value="customers">
              <UsersIcon className="size-4" aria-hidden /> Customers
            </TabsTrigger>
            <TabsTrigger value="inbox">
              <InboxIcon className="size-4" aria-hidden /> Inbox
            </TabsTrigger>
            <TabsTrigger value="board">
              <KanbanIcon className="size-4" aria-hidden /> Pipeline
            </TabsTrigger>
            <TabsTrigger value="schedule">
              <CalendarRangeIcon className="size-4" aria-hidden /> Schedule
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="today" className="mt-4">
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
            <DailyDispatch dispatch={dispatch} />
          )}
        </TabsContent>

        <TabsContent value="orders" className="mt-4">
          <OrdersTable orders={state.orders} />
        </TabsContent>

        {/* These two read for themselves, and only once opened — a customer
         * list nobody is looking at is not worth a request on every visit. */}
        <TabsContent value="customers" className="mt-4">
          <CustomersPanel />
        </TabsContent>

        <TabsContent value="inbox" className="mt-4">
          <SubmissionsInbox />
        </TabsContent>

        <TabsContent value="board" className="mt-4">
          <OrderBoard orders={state.orders} onMove={move} />
        </TabsContent>

        <TabsContent value="schedule" className="mt-4">
          <ResourceTimeline allocations={state.allocations} from={window.from} to={window.to} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
