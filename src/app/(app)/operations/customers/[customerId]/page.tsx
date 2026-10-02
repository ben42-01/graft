"use client";

/**
 * One customer: how to reach them, what they are worth, and every order they
 * have placed. Reached from an order, the customer list or the inbox — the
 * id is any record of theirs, so every one of those links lands here.
 */
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeftIcon, MailIcon, PhoneIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/shell/error-state";
import { LoadingState } from "@/components/shell/loading-state";
import { StatTile } from "@/components/home/stat-tile";
import { customerName } from "@/components/operations/customers-panel";
import { OrdersTable } from "@/components/operations/orders-table";
import { formatDate, formatMoney } from "@/lib/bms/format";
import { getJson, toBoardOrder, type ApiCustomer, type ApiOrder } from "@/lib/bms/reads";

type CustomerDetail = ApiCustomer & {
  answers: { key: string; label: string; value: string }[];
  orders: ApiOrder[];
};

type State =
  { status: "loading" } | { status: "error" } | { status: "ready"; customer: CustomerDetail };

export default function CustomerPage({ params }: { params: Promise<{ customerId: string }> }) {
  const { customerId } = use(params);
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void getJson<CustomerDetail>(`/api/v1/customers/${customerId}`).then((customer) => {
      if (cancelled) return;
      setState(customer ? { status: "ready", customer } : { status: "error" });
    });
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  const back = (
    <Link
      href="/operations?tab=customers"
      className="flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeftIcon className="size-4" aria-hidden /> Customers
    </Link>
  );

  if (state.status === "loading") {
    return <LoadingState label="Loading customer…" variant="page" />;
  }
  if (state.status === "error") {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        {back}
        <ErrorState description="We couldn't find that customer." />
      </div>
    );
  }

  const { customer } = state;
  const money = customer.money[0];
  const others = customer.money.length - 1;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      {back}

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{customerName(customer)}</h1>
        <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
          {customer.email ? (
            <li className="flex items-center gap-2">
              <MailIcon className="size-4 text-muted-foreground" aria-hidden />
              <a
                href={`mailto:${customer.email}`}
                className="underline-offset-4 hover:underline"
              >
                {customer.email}
              </a>
            </li>
          ) : null}
          {customer.phone ? (
            <li className="flex items-center gap-2">
              <PhoneIcon className="size-4 text-muted-foreground" aria-hidden />
              <a href={`tel:${customer.phone}`} className="underline-offset-4 hover:underline">
                {customer.phone}
              </a>
            </li>
          ) : null}
          <li className="text-muted-foreground">
            Customer since {formatDate(customer.firstOrderAt)}
          </li>
        </ul>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Orders"
          value={customer.orderCount}
          hint={`${customer.openOrderCount} open`}
        />
        <StatTile
          label="Spent"
          value={money ? formatMoney(money.bookedMinor, money.currency) : "—"}
          hint={
            others > 0
              ? `+ ${others} other ${others === 1 ? "currency" : "currencies"}`
              : "Cancelled orders excluded"
          }
        />
        <StatTile
          label="Paid"
          value={money ? formatMoney(money.paidMinor, money.currency) : "—"}
          hint="Received so far"
        />
        <StatTile
          label="Owes"
          value={money ? formatMoney(money.outstandingMinor, money.currency) : "—"}
          hint="Across open orders"
          tone={money && money.outstandingMinor > 0 ? "warn" : "default"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-3 lg:col-span-2">
          <h2 className="text-sm font-semibold">Orders</h2>
          <OrdersTable orders={customer.orders.map(toBoardOrder)} bare />
        </div>

        <Card className="gap-3 self-start px-5 py-5">
          <h2 className="text-sm font-semibold">Latest details</h2>
          {customer.answers.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing on file.</p>
          ) : (
            <dl className="flex flex-col gap-2.5 text-sm">
              {customer.answers.map((answer) => (
                <div key={answer.key}>
                  <dt className="text-xs text-muted-foreground">{answer.label}</dt>
                  <dd className="break-words whitespace-pre-wrap">{answer.value}</dd>
                </div>
              ))}
            </dl>
          )}
          <Link
            href={`/entities/${customer.entityId}`}
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Open their records →
          </Link>
        </Card>
      </div>
    </div>
  );
}
