"use client";

/**
 * Everyone who has ordered — the CRM the order pipeline implied and never
 * showed. Customers are derived server-side from the orders that share a
 * contact email (GET /api/v1/customers); this lists them with what they have
 * spent and still owe, and searches name, email and phone.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { SearchIcon, UsersIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/shell/empty-state";
import { ErrorState } from "@/components/shell/error-state";
import { LoadingState } from "@/components/shell/loading-state";
import { formatDate, formatMoney } from "@/lib/bms/format";
import { type ApiCustomer } from "@/lib/bms/reads";

type Sort = "recent" | "spend" | "orders";
type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; customers: ApiCustomer[]; total: number; truncated: boolean };

async function load(query: string, sort: Sort): Promise<State> {
  try {
    const params = new URLSearchParams({ sort, limit: "100" });
    if (query.trim()) params.set("q", query.trim());
    const response = await fetch(`/api/v1/customers?${params}`, { credentials: "include" });
    if (!response.ok) return { status: "error" };
    const body = (await response.json()) as {
      data: ApiCustomer[];
      meta: { total: number; truncated: boolean };
    };
    return {
      status: "ready",
      customers: body.data,
      total: body.meta.total,
      truncated: body.meta.truncated,
    };
  } catch {
    return { status: "error" };
  }
}

export function customerName(customer: Pick<ApiCustomer, "name" | "email" | "phone">): string {
  return customer.name ?? customer.email ?? customer.phone ?? "Unnamed customer";
}

export function CustomersPanel() {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    // Debounced: the search is a server read, and a request per keystroke
    // would spend the tenant's rate-limit budget on half-typed names.
    const timer = setTimeout(
      () => {
        void load(query, sort).then((next) => {
          if (!cancelled) setState(next);
        });
      },
      query ? 250 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, sort]);

  return (
    <div className="flex flex-col gap-3">
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
            placeholder="Search by name, email or phone"
            aria-label="Search customers"
            className="pl-8"
          />
        </div>
        <select
          value={sort}
          onChange={(event) => setSort(event.target.value as Sort)}
          aria-label="Sort customers"
          className="h-9 rounded-md border bg-background px-2 text-sm focus-visible:ring-2 focus-visible:ring-graft-green focus-visible:outline-none"
        >
          <option value="recent">Most recent order</option>
          <option value="spend">Highest spend</option>
          <option value="orders">Most orders</option>
        </select>
      </div>

      {state.status === "loading" ? <LoadingState label="Loading customers…" /> : null}
      {state.status === "error" ? (
        <ErrorState description="We couldn't load your customers." />
      ) : null}

      {state.status === "ready" && state.customers.length === 0 ? (
        query ? (
          <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            No customers match that.
          </p>
        ) : (
          <EmptyState
            icon={UsersIcon}
            title="No customers yet"
            description="Anyone who orders through one of your forms appears here, with everything they have ordered."
          />
        )
      ) : null}

      {state.status === "ready" && state.customers.length > 0 ? (
        <>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead className="hidden md:table-cell">Contact</TableHead>
                  <TableHead className="text-right">Orders</TableHead>
                  <TableHead className="text-right">Spent</TableHead>
                  <TableHead className="text-right">Owes</TableHead>
                  <TableHead className="hidden text-right md:table-cell">Last order</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.customers.map((customer) => {
                  const money = customer.money[0];
                  return (
                    <TableRow key={customer.id}>
                      <TableCell>
                        <Link
                          href={`/operations/customers/${customer.id}`}
                          className="font-medium underline-offset-4 hover:underline"
                        >
                          {customerName(customer)}
                        </Link>
                        {customer.openOrderCount > 0 ? (
                          <span className="block text-xs text-muted-foreground">
                            {customer.openOrderCount} open
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <span className="block truncate">{customer.email ?? "—"}</span>
                        {customer.phone ? (
                          <span className="block text-xs text-muted-foreground">
                            {customer.phone}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {customer.orderCount}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money ? formatMoney(money.bookedMinor, money.currency) : "—"}
                        {customer.money.length > 1 ? (
                          <span className="block text-xs text-muted-foreground">
                            + {customer.money.length - 1} more{" "}
                            {customer.money.length === 2 ? "currency" : "currencies"}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money && money.outstandingMinor > 0 ? (
                          formatMoney(money.outstandingMinor, money.currency)
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden text-right md:table-cell">
                        {formatDate(customer.lastOrderAt)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            {state.customers.length < state.total
              ? `Showing ${state.customers.length} of ${state.total} customers — search to narrow it.`
              : `${state.total} ${state.total === 1 ? "customer" : "customers"}`}
            {state.truncated ? " Built from your 5,000 most recent orders." : ""}
          </p>
        </>
      ) : null}
    </div>
  );
}
