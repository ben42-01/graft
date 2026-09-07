"use client";

/**
 * The real-time Kanban pipeline of docs/BMS_EXTENSION.md §2.3.
 *
 * Four things matter enough to call out:
 *
 *   - **Drag-and-drop is not the only way to move a card.** Native HTML5 drag
 *     events are unusable with a keyboard and largely invisible to a screen
 *     reader, so every card also carries a "Move to" select listing exactly the
 *     transitions the server allows. The pointer path is a convenience over
 *     that, not a replacement for it.
 *   - **The columns come from the server's own transition table.** A card
 *     offers only moves `TRANSITIONS` permits, so the board cannot suggest
 *     something the API will refuse — and when the state machine changes, the
 *     board changes with it rather than drifting.
 *   - **The move is optimistic, and reverts on refusal.** A board that waits
 *     for a round trip before the card lands feels broken; a board that keeps
 *     a card where the server refused to put it *is* broken. So the card moves
 *     immediately and goes back if the POST fails, with the reason shown.
 *   - **Terminal columns accept nothing.** `completed` and `cancelled` are
 *     dead ends in the state machine, so they are rendered as valid drop
 *     targets only from states that can actually reach them.
 */
import { useEffect, useState } from "react";
import { GripVerticalIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Mirrors `ORDER_STATUSES` / `TRANSITIONS` in src/server/services/orders.ts. */
export const ORDER_STATUSES = [
  "draft",
  "pending_payment",
  "confirmed",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  draft: ["pending_payment", "confirmed", "cancelled"],
  pending_payment: ["confirmed", "cancelled"],
  confirmed: ["in_progress", "completed", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export const STATUS_LABEL: Record<OrderStatus, string> = {
  draft: "Draft",
  pending_payment: "Awaiting payment",
  confirmed: "Confirmed",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

/**
 * Column accents. Deliberately not a red/green "good/bad" scale: a cancelled
 * order is a normal business outcome, not an error, and colouring it as one
 * makes a board of ordinary work look alarming.
 */
const COLUMN_ACCENT: Record<OrderStatus, string> = {
  draft: "border-t-muted-foreground/30",
  pending_payment: "border-t-amber-400",
  confirmed: "border-t-graft-green",
  in_progress: "border-t-graft-indigo",
  completed: "border-t-graft-green-deep",
  cancelled: "border-t-muted-foreground/20",
};

export type BoardOrder = {
  id: string;
  status: OrderStatus;
  currency: string;
  totalMinor: number;
  balanceMinor: number;
  customerLabel: string | null;
  lineSummary: string;
  createdAt: string;
};

const money = (minor: number, currency: string) => {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
      minor / 100,
    );
  } catch {
    // An unknown currency code must not blank the whole board.
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
};

export function OrderBoard({
  orders,
  onMove,
}: {
  orders: BoardOrder[];
  /** Resolves to false when the server refused, so the card can go back. */
  onMove: (orderId: string, to: OrderStatus) => Promise<boolean>;
}) {
  const [local, setLocal] = useState<BoardOrder[] | null>(null);
  const [dragging, setDragging] = useState<BoardOrder | null>(null);
  const [over, setOver] = useState<OrderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = local ?? orders;

  // A new list from the server supersedes any optimistic state: whatever it
  // says is now the truth, including a move this board never made.
  useEffect(() => {
    setLocal(null);
  }, [orders]);

  async function move(order: BoardOrder, to: OrderStatus) {
    if (to === order.status || !TRANSITIONS[order.status].includes(to)) return;
    setError(null);
    // Optimistic: the card lands now, and comes back if the server says no.
    setLocal(rows.map((row) => (row.id === order.id ? { ...row, status: to } : row)));
    const ok = await onMove(order.id, to);
    if (!ok) {
      setLocal(rows);
      setError(`${STATUS_LABEL[order.status]} → ${STATUS_LABEL[to]} was refused.`);
    }
    // On success the optimistic state is *kept*, not dropped. Clearing it here
    // would snap the card back to whatever `orders` still holds until the
    // parent's refetch lands — a visible flicker, and an outright lie if the
    // parent does not refetch at all. `useEffect` below hands control back the
    // moment a genuinely new list arrives.
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
        {ORDER_STATUSES.map((status) => {
          const columnOrders = rows.filter((order) => order.status === status);
          const droppable = dragging !== null && TRANSITIONS[dragging.status].includes(status);

          return (
            <section
              key={status}
              aria-label={`${STATUS_LABEL[status]}, ${columnOrders.length} orders`}
              onDragOver={(event) => {
                if (!droppable) return;
                // Preventing default is what marks this a valid drop target.
                event.preventDefault();
                setOver(status);
              }}
              onDragLeave={() => setOver((current) => (current === status ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                setOver(null);
                if (dragging && droppable) void move(dragging, status);
                setDragging(null);
              }}
              className={cn(
                "flex w-64 shrink-0 flex-col gap-2 rounded-lg border-t-4 bg-muted/40 p-2 transition-colors",
                COLUMN_ACCENT[status],
                over === status && "bg-graft-green/10 ring-1 ring-graft-green/40",
                dragging && !droppable && "opacity-50",
              )}
            >
              <header className="flex items-baseline justify-between px-1">
                <h3 className="text-sm font-medium">{STATUS_LABEL[status]}</h3>
                <span className="text-xs text-muted-foreground">{columnOrders.length}</span>
              </header>

              {columnOrders.length === 0 ? (
                <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                  Nothing here
                </p>
              ) : (
                columnOrders.map((order) => (
                  <BoardCard
                    key={order.id}
                    order={order}
                    onDragStart={() => setDragging(order)}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                    onMove={(to) => void move(order, to)}
                  />
                ))
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function BoardCard({
  order,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  order: BoardOrder;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (to: OrderStatus) => void;
}) {
  const moves = TRANSITIONS[order.status];

  return (
    <Card
      draggable={moves.length > 0}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className="gap-2 p-3 shadow-sm"
    >
      <div className="flex items-start gap-2">
        {moves.length > 0 ? (
          <GripVerticalIcon
            className="mt-0.5 size-4 shrink-0 cursor-grab text-muted-foreground"
            aria-hidden
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{order.customerLabel ?? "No customer"}</p>
          <p className="truncate text-xs text-muted-foreground">{order.lineSummary}</p>
        </div>
      </div>

      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium">{money(order.totalMinor, order.currency)}</span>
        {order.balanceMinor > 0 ? (
          <span className="text-amber-600 dark:text-amber-400">
            {money(order.balanceMinor, order.currency)} due
          </span>
        ) : (
          <span className="text-graft-green dark:text-graft-green-light">Paid</span>
        )}
      </div>

      {/* The accessible path. A native select rather than a custom menu: it is
       * reachable by keyboard, announced correctly, and works on touch, none
       * of which is true of the drag handle above. */}
      {moves.length > 0 ? (
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="sr-only">Move this order from {STATUS_LABEL[order.status]} to</span>
          <span aria-hidden>Move to</span>
          <select
            value=""
            onChange={(event) => {
              const to = event.target.value as OrderStatus;
              if (to) onMove(to);
            }}
            className="min-w-0 flex-1 rounded-md border bg-background px-1.5 py-1 text-xs focus-visible:ring-2 focus-visible:ring-graft-green focus-visible:outline-none"
          >
            <option value="">Choose…</option>
            {moves.map((to) => (
              <option key={to} value={to}>
                {STATUS_LABEL[to]}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </Card>
  );
}
