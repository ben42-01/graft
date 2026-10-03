"use client";

/**
 * The Overview — the default dashboard, and the screen a tenant lands on.
 *
 * The problem it fixes: the product shipped three overlapping "dashboard"
 * surfaces. `/home` was a welcome line and an entity count, `/operations` was
 * the real command view, and `/dashboards` asked the user to assemble their
 * own. A new tenant landed on the emptiest of the three and was invited to
 * build the product before using it. So the widget composer is no longer the
 * way you get a dashboard — it is the way you get a *different* dashboard —
 * and this screen gives everyone the BMS experience without building anything.
 *
 * Four decisions worth stating:
 *
 *   - **Composed, not configured.** Like `/operations`, every panel comes
 *     from endpoints that already exist (`src/lib/bms/reads.ts` is shared
 *     with that screen, joins and all). There is no `/overview` contract to
 *     go stale, and no stored layout to migrate.
 *   - **Every panel degrades on its own.** The reads are independent, and a
 *     refused one (a tier gate, a plugin a tenant hasn't enabled) costs the
 *     reader that panel and nothing else. The screen only errors when the
 *     tenant's own entities can't be read, which is the one thing nothing
 *     here works without.
 *   - **The headline figures are the one server-computed read.**
 *     `GET /api/v1/reports/summary` totals what a page of 100 orders cannot:
 *     30 days of bookings and payments, and customers counted by person
 *     rather than by order. It is still an independent panel — refused, the
 *     tiles say so and the rest of the screen is unaffected. The trend behind
 *     those figures (`SalesPanel`) is Premium and gated on the server.
 *   - **It is a hub, not a terminus.** Every number is a doorway into the
 *     screen that can act on it. A dashboard whose figures can only be looked
 *     at sends the reader off to find the real screen themselves.
 *
 * The tier gate on "Add entity" tracks the actual quota, not the tier: Free
 * is entitled to 3 entities (`TIER_LIMITS.free.entities`) and `createEntity`
 * enforces a quota, never a tier (2026-08-21 UI refinement — a `tier !==
 * "free"` check used to tell Free tenants to upgrade to create their first).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRightIcon, LayoutGridIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NewEntityDialog } from "@/components/entities/new-entity-dialog";
import { GatedControl } from "@/components/ui/gated-control";
import { ErrorState } from "@/components/shell/error-state";
import { LoadingState } from "@/components/shell/loading-state";
import { buildDispatch, DailyDispatch } from "@/components/operations/daily-dispatch";
import type { BoardOrder } from "@/components/operations/order-board";
import type { TimelineAllocation } from "@/components/operations/resource-timeline";
import { StatTile, type StatTone } from "@/components/home/stat-tile";
import { PipelineSummary } from "@/components/home/pipeline-summary";
import {
  buildSetupSteps,
  hasOutstandingStep,
  SetupChecklist,
} from "@/components/home/setup-checklist";
import { SalesPanel } from "@/components/home/sales-panel";
import { SubmissionsInbox } from "@/components/operations/submissions-inbox";
import { formatMoney } from "@/lib/bms/format";
import { getJson, loadOperations, todayWindow, type ApiBusinessSummary } from "@/lib/bms/reads";
import { useMe } from "@/lib/session";

/** The schedule reads a week ahead; the dispatch panel narrows it to today. */
const WINDOW_DAYS = 7;

type MeterReading = { used: number; limit: number | null };

type Overview = {
  entityCount: number;
  /** `null` throughout means "the read failed", never "none" — the Overview
   * would rather show nothing than a confident zero. */
  formCount: number | null;
  orders: BoardOrder[] | null;
  allocations: TimelineAllocation[] | null;
  records: MeterReading | null;
  submissions: MeterReading | null;
  /** The server's headline figures — every tier gets these. */
  summary: ApiBusinessSummary | null;
};

type State = { status: "loading" } | { status: "error" } | ({ status: "ready" } & Overview);

/** `/me` reports the tenant's materialised limits as loose JSON; anything that
 * isn't a number tells us nothing, so it is treated as unlimited rather than
 * as a gate. `null` is unlimited and is branched on, never compared. */
function readLimit(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(minor / 100);
  } catch {
    return `${Math.round(minor / 100)} ${currency}`;
  }
}

/** Statuses that represent work still on someone's plate. */
const LIVE = new Set(["draft", "pending_payment", "confirmed", "in_progress"]);

/**
 * Outstanding money, grouped by currency and reported for the largest one.
 * Summing across currencies would produce a number that is not any amount of
 * anything; a tenant trading in two is told there is a second rather than
 * shown a total that silently adds euros to pounds.
 */
function outstanding(orders: BoardOrder[]): { amount: string; others: number } | null {
  const totals = new Map<string, number>();
  for (const order of orders) {
    if (!LIVE.has(order.status) || order.balanceMinor <= 0) continue;
    totals.set(order.currency, (totals.get(order.currency) ?? 0) + order.balanceMinor);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  if (!top) return null;
  return { amount: money(top[1], top[0]), others: ranked.length - 1 };
}

/** This 30 days against the last, in words — a percentage of nothing is not
 * a trend, so the first sales and a quiet month each get a plain sentence. */
function bookedTrend(summary: ApiBusinessSummary): string {
  const current = summary.money.bookedLast30DaysMinor;
  const previous = summary.money.bookedPrevious30DaysMinor;
  if (!summary.currency) return "No orders yet";
  if (previous === 0)
    return current === 0 ? "Nothing booked yet" : "No sales the 30 days before";
  const change = Math.round(((current - previous) / previous) * 100);
  return `${change >= 0 ? "+" : "−"}${Math.abs(change)}% on the 30 days before`;
}

/** How much of a metered allowance is gone — amber past the 80% the server
 * itself warns at, red at the ceiling. */
function quotaTone(reading: MeterReading | null): StatTone {
  if (!reading || reading.limit === null || reading.limit === 0) return "default";
  const ratio = reading.used / reading.limit;
  if (ratio >= 1) return "danger";
  return ratio >= 0.8 ? "warn" : "default";
}

export default function AppHomePage() {
  const router = useRouter();
  const { me } = useMe();
  const [state, setState] = useState<State>({ status: "loading" });
  const [newEntityOpen, setNewEntityOpen] = useState(false);

  const window = useMemo(() => todayWindow(new Date(), WINDOW_DAYS), []);

  const load = useCallback(async () => {
    const [entities, forms, operations, records, submissions, summary] = await Promise.all([
      getJson<unknown[]>("/api/v1/entities"),
      getJson<unknown[]>("/api/v1/forms?limit=100"),
      loadOperations(window),
      getJson<MeterReading>("/api/v1/meters/records"),
      getJson<MeterReading>("/api/v1/meters/form_submissions"),
      getJson<ApiBusinessSummary>("/api/v1/reports/summary"),
    ]);

    // Entities are what every other panel is ultimately about; if that read
    // failed, the screen has nothing honest to render.
    if (!entities) {
      setState({ status: "error" });
      return;
    }

    setState({
      status: "ready",
      entityCount: entities.length,
      formCount: forms?.length ?? null,
      orders: operations.orders,
      allocations: operations.allocations,
      records,
      submissions,
      summary,
    });
  }, [window]);

  useEffect(() => {
    void load();
  }, [load]);

  const entityLimit = readLimit(me?.tenant.limits.entities);
  const entityCount = state.status === "ready" ? state.entityCount : 0;
  const atEntityLimit =
    state.status === "ready" && entityLimit !== null && entityCount >= entityLimit;
  const canAddEntity = state.status === "ready" && !atEntityLimit;

  if (state.status === "loading")
    return <LoadingState label="Loading your overview…" variant="page" />;
  if (state.status === "error") {
    return <ErrorState description="We couldn't load your overview. Please try again." />;
  }

  const orders = state.orders ?? [];
  const allocations = state.allocations ?? [];
  const now = new Date();
  const dispatch = buildDispatch(allocations, orders, now);

  const openOrders = orders.filter((order) => LIVE.has(order.status)).length;
  const owed = outstanding(orders);
  const outToday = dispatch.active.length + dispatch.starting.length;
  const hasOperations = orders.length > 0 || allocations.length > 0;

  const steps = buildSetupSteps({
    entityCount: state.entityCount,
    recordCount: state.records ? state.records.used : null,
    formCount: state.formCount,
    orderCount: state.orders ? state.orders.length : null,
  });
  const setupIncomplete = hasOutstandingStep(steps);

  const { summary } = state;
  const canSeeReports = me?.tenant.features?.reports === true;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {me?.tenant.name ?? "Overview"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {now.toLocaleDateString(undefined, {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}{" "}
            — how the business is doing, today&apos;s work and your pipeline.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboards">
              <LayoutGridIcon /> Custom views
            </Link>
          </Button>
          <GatedControl
            allowed={canAddEntity}
            upgradeMessage={
              atEntityLimit ? `You've used all ${entityLimit} entities on your plan.` : ""
            }
            upgradeHref={atEntityLimit ? "/account" : null}
          >
            <Button type="button" size="sm" onClick={() => setNewEntityOpen(true)}>
              <PlusIcon /> Add entity
            </Button>
          </GatedControl>
        </div>
      </div>

      {/* The business first — what was sold, what came in, who is owed — then
       * the day's workload underneath. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Booked · 30 days"
          value={
            summary?.currency
              ? formatMoney(summary.money.bookedLast30DaysMinor, summary.currency, {
                  whole: true,
                })
              : "—"
          }
          hint={summary ? bookedTrend(summary) : "Unavailable"}
          href="/operations?tab=orders"
          loading={summary === null}
        />
        <StatTile
          label="Collected · 30 days"
          value={
            summary?.currency
              ? formatMoney(summary.money.collectedLast30DaysMinor, summary.currency, {
                  whole: true,
                })
              : "—"
          }
          hint={summary ? "Payments received" : "Unavailable"}
          href="/operations?tab=orders"
          loading={summary === null}
        />
        <StatTile
          label="Customers"
          value={summary ? summary.customers.total.toLocaleString() : "—"}
          hint={
            summary
              ? summary.customers.newLast30Days > 0
                ? `${summary.customers.newLast30Days} new in 30 days`
                : "Everyone who has ordered"
              : "Unavailable"
          }
          href="/operations?tab=customers"
          loading={summary === null}
        />
        <StatTile
          label="New orders · 7 days"
          value={summary ? summary.orders.last7Days.toLocaleString() : "—"}
          hint={summary ? `${summary.orders.previous7Days} the week before` : "Unavailable"}
          href="/operations?tab=orders"
          loading={summary === null}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Open orders"
          value={openOrders}
          hint={state.orders === null ? "Unavailable" : "Still to fulfil"}
          href="/operations"
          loading={state.orders === null}
        />
        <StatTile
          label="Outstanding"
          value={owed ? owed.amount : money(0, orders[0]?.currency ?? "USD")}
          hint={
            owed && owed.others > 0
              ? `+ ${owed.others} other ${owed.others === 1 ? "currency" : "currencies"}`
              : "Unpaid balances"
          }
          tone={owed ? "warn" : "default"}
          href="/operations"
          loading={state.orders === null}
        />
        <StatTile
          label="Out today"
          value={outToday}
          hint={state.allocations === null ? "Unavailable" : "Resources in use"}
          href="/operations"
          loading={state.allocations === null}
        />
        <StatTile
          label="Submissions"
          value={state.submissions ? state.submissions.used.toLocaleString() : "—"}
          hint={
            state.submissions
              ? state.submissions.limit === null
                ? "No limit on your plan"
                : `of ${state.submissions.limit.toLocaleString()} this month`
              : "Unavailable"
          }
          tone={quotaTone(state.submissions)}
          href="/account"
        />
      </div>

      {/* Only once something has been sold: an empty trend, or an upgrade
       * prompt for a chart of nothing, is not what a new tenant needs. */}
      {orders.length > 0 ? (
        // `min-w-0` on each cell: a grid item will not shrink below its
        // content, and a truncated line counts as full-width content — without
        // it a long name pushes the card off a phone screen.
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="min-w-0 lg:col-span-2">
            <SalesPanel allowed={canSeeReports} />
          </div>
          <Card className="min-w-0 gap-3 px-5 py-5">
            <SectionHeading title="Latest activity" href="/operations?tab=inbox" cta="Inbox" />
            <SubmissionsInbox limit={6} />
          </Card>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {hasOperations ? (
            <div className="flex flex-col gap-3">
              <SectionHeading title="Today" href="/operations" cta="Open operations" />
              <DailyDispatch dispatch={dispatch} />
            </div>
          ) : (
            <Card className="px-5 py-5">
              <SetupChecklist steps={steps} />
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <Card className="gap-3 px-5 py-5">
            <SectionHeading title="Pipeline" href="/operations?tab=board" cta="Board" />
            <PipelineSummary orders={orders} />
          </Card>

          {/* Once there is real work on screen the checklist moves out of the
           * way, but an unfinished step is still worth surfacing — a tenant
           * with orders and no published form is leaving the front door shut. */}
          {hasOperations && setupIncomplete ? (
            <Card className="px-5 py-5">
              <SetupChecklist steps={steps} />
            </Card>
          ) : null}
        </div>
      </div>

      <NewEntityDialog
        open={newEntityOpen}
        onOpenChange={setNewEntityOpen}
        onCreated={(entity) => {
          // Straight into the entity — creating one and being returned to a
          // counter is exactly the dead end this refinement is fixing.
          router.push(`/entities/${entity.id}`);
        }}
      />
    </div>
  );
}

function SectionHeading({ title, href, cta }: { title: string; href: string; cta: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      <Link
        href={href}
        className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        {cta} <ArrowRightIcon className="size-3" />
      </Link>
    </div>
  );
}
