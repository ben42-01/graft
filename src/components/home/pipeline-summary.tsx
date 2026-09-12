"use client";

/**
 * The order pipeline as a shape rather than a board — how much work sits in
 * each stage, and where it is stuck.
 *
 * The full Kanban lives at `/operations`; repeating it on the Overview would
 * make the landing screen a slower version of a screen that already exists.
 * What belongs here is the one question the pipeline answers at a glance:
 * "is anything piling up?" So this is counts and proportion, and every row
 * is a link into the board that can actually move the work.
 *
 * Terminal states are summarised on one line instead of getting a row each.
 * `completed` and `cancelled` only grow, so given a few months of trading
 * they would dominate the chart and say nothing about today.
 */
import Link from "next/link";
import {
  ORDER_STATUSES,
  STATUS_LABEL,
  type BoardOrder,
  type OrderStatus,
} from "@/components/operations/order-board";
import { cn } from "@/lib/utils";

/** The stages work actually moves through — the ones worth a row. */
const LIVE_STATUSES: readonly OrderStatus[] = [
  "draft",
  "pending_payment",
  "confirmed",
  "in_progress",
];

const BAR_CLASS: Record<string, string> = {
  draft: "bg-muted-foreground/40",
  pending_payment: "bg-graft-warn",
  confirmed: "bg-graft-green",
  in_progress: "bg-graft-green-light",
};

export function countByStatus(orders: BoardOrder[]): Record<OrderStatus, number> {
  const counts = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0])) as Record<
    OrderStatus,
    number
  >;
  for (const order of orders) counts[order.status] += 1;
  return counts;
}

export function PipelineSummary({ orders }: { orders: BoardOrder[] }) {
  const counts = countByStatus(orders);
  const live = LIVE_STATUSES.reduce((total, status) => total + counts[status], 0);
  const settled = counts.completed + counts.cancelled;

  return (
    <div>
      {live === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">Nothing in the pipeline right now.</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {LIVE_STATUSES.map((status) => {
            const count = counts[status];
            const share = live === 0 ? 0 : count / live;
            return (
              <li key={status}>
                <Link
                  href="/operations"
                  className="group flex items-center gap-3 rounded-md text-sm"
                >
                  <span className="w-32 shrink-0 truncate text-muted-foreground group-hover:text-foreground">
                    {STATUS_LABEL[status]}
                  </span>
                  <span
                    className="h-1.5 min-w-1.5 flex-1 overflow-hidden rounded-full bg-muted"
                    aria-hidden="true"
                  >
                    <span
                      className={cn("block h-full rounded-full", BAR_CLASS[status])}
                      style={{ width: `${Math.max(share * 100, count > 0 ? 6 : 0)}%` }}
                    />
                  </span>
                  <span className="w-8 shrink-0 text-right font-medium tabular-nums">
                    {count}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {settled > 0 ? (
        <p className="mt-3 border-t pt-2.5 text-xs text-muted-foreground">
          {counts.completed} completed · {counts.cancelled} cancelled
        </p>
      ) : null}
    </div>
  );
}
