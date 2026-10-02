"use client";

/**
 * Every order as a list — the view the board cannot be. A Kanban answers
 * "what stage is everything at"; this answers "find me the order from the
 * woman who rang about the fruit boxes", which needs a name to search and a
 * row to click.
 *
 * Filtering is done here, over the page the screen already loaded, rather
 * than as a request per keystroke: the customer's name is resolved at read
 * time from their record and is not something the orders collection can be
 * queried by.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { SearchIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, formatMoney, orderNumber } from "@/lib/bms/format";
import { ORDER_STATUSES, STATUS_LABEL, type BoardOrder, type OrderStatus } from "./order-board";
import { StatusBadge } from "./status-badge";

type Filter = OrderStatus | "all" | "unpaid";

export function filterOrders(
  orders: BoardOrder[],
  query: string,
  filter: Filter,
): BoardOrder[] {
  const needle = query.trim().toLowerCase();
  return orders.filter((order) => {
    if (filter === "unpaid") {
      if (order.balanceMinor <= 0 || order.status === "cancelled") return false;
    } else if (filter !== "all" && order.status !== filter) {
      return false;
    }
    if (!needle) return true;
    return [
      order.customerLabel,
      order.lineSummary,
      order.sourceLabel,
      orderNumber(order.id),
    ].some((value) => value?.toLowerCase().includes(needle));
  });
}

export function OrdersTable({
  orders,
  /** Hides the search and filter — for a customer's own short order history. */
  bare = false,
}: {
  orders: BoardOrder[];
  bare?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const rows = useMemo(() => filterOrders(orders, query, filter), [orders, query, filter]);

  return (
    <div className="flex flex-col gap-3">
      {bare ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-48 flex-1">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by customer, item or order number"
              aria-label="Search orders"
              className="pl-8"
            />
          </div>
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as Filter)}
            aria-label="Filter orders"
            className="h-9 rounded-md border bg-background px-2 text-sm focus-visible:ring-2 focus-visible:ring-graft-green focus-visible:outline-none"
          >
            <option value="all">All orders</option>
            <option value="unpaid">With a balance due</option>
            {ORDER_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABEL[status]}
              </option>
            ))}
          </select>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          {orders.length === 0 ? "No orders yet." : "No orders match that."}
        </p>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead className="hidden md:table-cell">Items</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Total</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((order) => (
                <TableRow key={order.id}>
                  <TableCell>
                    <Link
                      href={`/operations/orders/${order.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {orderNumber(order.id)}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {formatDate(order.createdAt)}
                    </span>
                  </TableCell>
                  <TableCell>
                    {order.customerId ? (
                      <Link
                        href={`/operations/customers/${order.customerId}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {order.customerLabel}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">No customer</span>
                    )}
                    {order.sourceLabel ? (
                      <span className="block text-xs text-muted-foreground">
                        via {order.sourceLabel}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="hidden max-w-64 truncate md:table-cell">
                    {order.lineSummary}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={order.status} />
                  </TableCell>
                  <TableCell className="hidden text-right tabular-nums sm:table-cell">
                    {formatMoney(order.totalMinor, order.currency)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {order.status === "cancelled" ? (
                      <span className="text-muted-foreground">—</span>
                    ) : order.balanceMinor > 0 ? (
                      formatMoney(order.balanceMinor, order.currency)
                    ) : (
                      <span className="text-muted-foreground">Paid</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
