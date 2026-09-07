"use client";

/**
 * The daily operations dispatch of docs/BMS_EXTENSION.md §2.3 — "actionable
 * overview of daily arrivals, active rentals, unsigned waivers, and pending
 * payments".
 *
 * Three things matter enough to call out:
 *
 *   - **Every panel is something someone has to *do* today.** Counts that
 *     nobody acts on belong on a dashboard widget, not here. So the panels are
 *     starting, running, coming back, and owing money — and each row names the
 *     resource and the time rather than an id.
 *   - **"Unsigned waivers" is deliberately absent.** Waivers are a tenant-
 *     defined form field, not a platform concept; inventing a `waiverSigned`
 *     flag would bake one business's compliance model into the product.
 *     Documented here rather than silently dropped — it belongs to the Forms
 *     plugin once a form can be marked required-before-collection.
 *   - **Empty is stated, not blank.** "Nothing starting today" is information;
 *     an empty panel is a bug the reader has to rule out.
 */
import type { ReactNode } from "react";
import {
  AlertCircleIcon,
  ArrowRightCircleIcon,
  BanknoteIcon,
  PlayCircleIcon,
  type LucideIcon,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { TimelineAllocation } from "./resource-timeline";
import type { BoardOrder } from "./order-board";

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const money = (minor: number, currency: string) => {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
      minor / 100,
    );
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
};

export type Dispatch = {
  starting: TimelineAllocation[];
  active: TimelineAllocation[];
  returning: TimelineAllocation[];
  owing: BoardOrder[];
};

/**
 * Splits the day's allocations into what is about to start, what is out right
 * now, and what is due back — computed here rather than server-side so the
 * boundaries move with the viewer's own clock rather than the server's.
 */
export function buildDispatch(
  allocations: TimelineAllocation[],
  orders: BoardOrder[],
  now: Date,
): Dispatch {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay.getTime() + 86_400_000);

  const live = allocations.filter((a) => a.status === "held" || a.status === "confirmed");

  const within = (iso: string) => {
    const at = new Date(iso);
    return at >= startOfDay && at < endOfDay;
  };

  return {
    starting: live
      .filter((a) => within(a.startAt) && new Date(a.startAt) > now)
      .sort((a, b) => a.startAt.localeCompare(b.startAt)),
    active: live
      .filter((a) => new Date(a.startAt) <= now && new Date(a.endAt) > now)
      .sort((a, b) => a.endAt.localeCompare(b.endAt)),
    returning: live
      .filter((a) => within(a.endAt) && new Date(a.endAt) > now)
      .sort((a, b) => a.endAt.localeCompare(b.endAt)),
    owing: orders
      .filter(
        (order) =>
          order.balanceMinor > 0 && order.status !== "cancelled" && order.status !== "draft",
      )
      .sort((a, b) => b.balanceMinor - a.balanceMinor),
  };
}

export function DailyDispatch({ dispatch }: { dispatch: Dispatch }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Panel
        icon={ArrowRightCircleIcon}
        title="Starting today"
        count={dispatch.starting.length}
        empty="Nothing else starts today."
      >
        {dispatch.starting.map((a) => (
          <Row
            key={a.id}
            label={a.resourceLabel}
            value={time(a.startAt)}
            hint={statusHint(a)}
          />
        ))}
      </Panel>

      <Panel
        icon={PlayCircleIcon}
        title="Out now"
        count={dispatch.active.length}
        empty="Nothing is out at the moment."
        accent
      >
        {dispatch.active.map((a) => (
          <Row
            key={a.id}
            label={a.resourceLabel}
            value={`back ${time(a.endAt)}`}
            hint={statusHint(a)}
          />
        ))}
      </Panel>

      <Panel
        icon={AlertCircleIcon}
        title="Due back today"
        count={dispatch.returning.length}
        empty="Nothing is due back today."
      >
        {dispatch.returning.map((a) => (
          <Row key={a.id} label={a.resourceLabel} value={time(a.endAt)} hint={statusHint(a)} />
        ))}
      </Panel>

      <Panel
        icon={BanknoteIcon}
        title="Money owed"
        count={dispatch.owing.length}
        empty="Everything is paid up."
      >
        {dispatch.owing.map((order) => (
          <Row
            key={order.id}
            label={order.customerLabel ?? "No customer"}
            value={money(order.balanceMinor, order.currency)}
            hint={order.lineSummary}
          />
        ))}
      </Panel>
    </div>
  );
}

/** A hold is worth flagging: it lapses on its own if nobody confirms it. */
const statusHint = (a: TimelineAllocation): string | undefined =>
  a.status === "held" ? "Unconfirmed hold" : undefined;

function Panel({
  icon: Icon,
  title,
  count,
  empty,
  accent,
  children,
}: {
  icon: LucideIcon;
  title: string;
  count: number;
  empty: string;
  accent?: boolean;
  children: ReactNode;
}) {
  return (
    <Card className={accent && count > 0 ? "border-graft-green/40" : undefined}>
      <CardHeader className="flex flex-row items-center gap-2">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        <CardTitle className="text-base">{title}</CardTitle>
        <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {count}
        </span>
      </CardHeader>
      <CardContent>
        {count === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="flex flex-col divide-y">{children}</ul>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <li className="flex items-baseline justify-between gap-3 py-2 first:pt-0 last:pb-0">
      <span className="min-w-0">
        <span className="block truncate text-sm">{label}</span>
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
      <span className="shrink-0 text-sm font-medium tabular-nums">{value}</span>
    </li>
  );
}
