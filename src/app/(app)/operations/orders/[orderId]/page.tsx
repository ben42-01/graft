"use client";

/**
 * One order, in full — the screen the board's cards open onto.
 *
 * The board could move an order and nothing else; who it was for, what they
 * had typed into the form, what had been paid and what was invoiced each
 * lived behind a different endpoint with no screen. This is those four reads
 * on one page, with the things an operator actually does to an order: move it
 * on, send a payment link, take a payment, issue an invoice — and, while it is
 * still a draft, edit it.
 *
 * Every action re-reads the order rather than patching local state: taking a
 * deposit can confirm the order, and confirming it moves its allocations, so
 * the server's answer is the only one worth showing.
 */
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeftIcon, FileTextIcon, MailIcon, PencilIcon, PhoneIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { GatedControl } from "@/components/ui/gated-control";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorState } from "@/components/shell/error-state";
import { LoadingState } from "@/components/shell/loading-state";
import {
  STATUS_LABEL,
  TRANSITIONS,
  type OrderStatus,
} from "@/components/operations/order-board";
import {
  OrderPaymentLink,
  type OrderPaymentLinkView,
} from "@/components/operations/order-payment-link";
import { StatusBadge } from "@/components/operations/status-badge";
import { formatDate, formatDateTime, formatMoney, orderNumber } from "@/lib/bms/format";
import {
  customerLabel,
  getJson,
  type ApiCustomerRef,
  type ApiOrderSource,
} from "@/lib/bms/reads";
import { useMe } from "@/lib/session";

type LineItem = {
  kind: string;
  description: string;
  quantity: number;
  unitAmountMinor: number;
  amountMinor: number;
};

type OrderDetail = {
  id: string;
  status: OrderStatus;
  currency: string;
  lineItems: LineItem[];
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  depositMinor: number;
  amountPaidMinor: number;
  balanceMinor: number;
  payments: { amountMinor: number; reference: string | null; at: string }[];
  notes: string | null;
  paymentLink: OrderPaymentLinkView;
  createdAt: string;
  customer: ApiCustomerRef | null;
  source: ApiOrderSource | null;
  answers: { key: string; label: string; value: string }[];
};

type Invoice = {
  id: string;
  number: string;
  kind: string;
  status: string;
  currency: string;
  amountDueMinor: number;
  dueAt: string;
};

type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; order: OrderDetail; invoices: Invoice[] | null };

/** Sends an action and reports the server's own reason when it says no. */
async function post(url: string, body: unknown, method = "POST"): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method,
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return null;
    const failure = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return failure?.error?.message ?? "That didn't go through. Please try again.";
  } catch {
    return "That didn't go through. Please try again.";
  }
}

export default function OrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = use(params);
  const { me } = useMe();
  const [state, setState] = useState<State>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");

  const load = useCallback(async () => {
    const [order, ledger] = await Promise.all([
      getJson<OrderDetail>(`/api/v1/orders/${orderId}`),
      getJson<{ invoices: Invoice[] }>(`/api/v1/orders/${orderId}/ledger`),
    ]);
    setState(
      order
        ? { status: "ready", order, invoices: ledger ? ledger.invoices : null }
        : { status: "error" },
    );
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (name: string, url: string, body: unknown) => {
      setBusy(name);
      setError(null);
      const failure = await post(url, body);
      if (failure) setError(failure);
      await load();
      setBusy(null);
      return failure === null;
    },
    [load],
  );

  if (state.status === "loading") return <LoadingState label="Loading order…" variant="page" />;
  if (state.status === "error") {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <BackLink />
        <ErrorState description="We couldn't find that order." />
      </div>
    );
  }

  const { order, invoices } = state;
  const moves = TRANSITIONS[order.status];
  const canPay = moves.length > 0 && order.balanceMinor > 0;
  const who = customerLabel(order.customer);
  const canInvoice = me?.tenant.features?.invoicing === true;
  const amountMinor = Math.round(Number(amount.replace(",", ".")) * 100);
  const amountValid = Number.isFinite(amountMinor) && amountMinor > 0;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <BackLink />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              Order {orderNumber(order.id)}
            </h1>
            <StatusBadge status={order.status} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Placed {formatDateTime(order.createdAt)}
            {order.source ? (
              <>
                {" "}
                through{" "}
                <Link
                  href={`/forms/${order.source.formId}`}
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  {order.source.formName ?? "a form"}
                </Link>
              </>
            ) : (
              " · entered by hand"
            )}
          </p>
        </div>

        {moves.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {/* Only a draft: after that the lines are what the customer agreed to. */}
            {order.status === "draft" ? (
              <Button asChild size="sm" variant="outline">
                <Link href={`/operations/orders/${order.id}/edit`}>
                  <PencilIcon /> Edit
                </Link>
              </Button>
            ) : null}
            {moves.map((to) => (
              <Button
                key={to}
                type="button"
                size="sm"
                variant={to === "cancelled" ? "outline" : "default"}
                loading={busy === to}
                disabled={busy !== null}
                onClick={() =>
                  void act(to, `/api/v1/orders/${order.id}/transitions`, { status: to })
                }
              >
                {to === "cancelled" ? "Cancel order" : `Mark ${STATUS_LABEL[to].toLowerCase()}`}
              </Button>
            ))}
          </div>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card className="gap-3 px-5 py-5">
            <h2 className="text-sm font-semibold">Items</h2>
            <ul className="flex flex-col divide-y">
              {order.lineItems.map((line, index) => (
                <li key={index} className="flex items-baseline justify-between gap-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{line.description}</span>
                    <span className="block text-xs text-muted-foreground">
                      {line.quantity} × {formatMoney(line.unitAmountMinor, order.currency)}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-medium tabular-nums">
                    {formatMoney(line.amountMinor, order.currency)}
                  </span>
                </li>
              ))}
            </ul>
            <dl className="flex flex-col gap-1 border-t pt-3 text-sm">
              {order.discountMinor > 0 ? (
                <Figure
                  label="Discount"
                  value={`− ${formatMoney(order.discountMinor, order.currency)}`}
                />
              ) : null}
              <Figure
                label="Total"
                value={formatMoney(order.totalMinor, order.currency)}
                strong
              />
              {order.depositMinor > 0 ? (
                <Figure
                  label="Deposit to confirm"
                  value={formatMoney(order.depositMinor, order.currency)}
                />
              ) : null}
              <Figure label="Paid" value={formatMoney(order.amountPaidMinor, order.currency)} />
              <Figure
                label="Balance due"
                value={formatMoney(order.balanceMinor, order.currency)}
                strong
              />
            </dl>
          </Card>

          <Card className="gap-3 px-5 py-5">
            <h2 className="text-sm font-semibold">Payments</h2>
            {order.payments.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing has been paid yet.</p>
            ) : (
              <ul className="flex flex-col divide-y">
                {order.payments.map((payment, index) => (
                  <li key={index} className="flex items-baseline justify-between gap-3 py-2">
                    <span className="min-w-0">
                      <span className="block text-sm">{formatDateTime(payment.at)}</span>
                      {payment.reference ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {payment.reference}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-sm font-medium tabular-nums">
                      {formatMoney(payment.amountMinor, order.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {order.balanceMinor > 0 && (canPay || order.paymentLink) ? (
              <OrderPaymentLink
                orderId={order.id}
                link={order.paymentLink}
                editable={canPay}
                amountMinor={order.balanceMinor}
                currency={order.currency}
                businessName={me?.tenant.name ?? ""}
                customerName={order.customer?.name ?? null}
                customerEmail={order.customer?.email ?? null}
                onSave={async (url) => {
                  const failure = await post(
                    `/api/v1/orders/${order.id}/payment-link`,
                    { url },
                    "PUT",
                  );
                  await load();
                  return failure;
                }}
                onSend={async () => {
                  const failure = await post(
                    `/api/v1/orders/${order.id}/payment-link/send`,
                    {},
                  );
                  await load();
                  return failure;
                }}
              />
            ) : null}

            {canPay ? (
              <form
                className="flex flex-wrap items-end gap-2 border-t pt-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!amountValid) return;
                  void act("payment", `/api/v1/orders/${order.id}/payments`, {
                    amountMinor,
                    ...(reference.trim() ? { reference: reference.trim() } : {}),
                  }).then((ok) => {
                    if (!ok) return;
                    setAmount("");
                    setReference("");
                  });
                }}
              >
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="payment-amount">Amount ({order.currency})</Label>
                  <Input
                    id="payment-amount"
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    placeholder={(order.balanceMinor / 100).toFixed(2)}
                    className="w-32"
                  />
                </div>
                <div className="flex min-w-40 flex-1 flex-col gap-1.5">
                  <Label htmlFor="payment-reference">Reference (optional)</Label>
                  <Input
                    id="payment-reference"
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                    placeholder="Cash, bank transfer…"
                    maxLength={200}
                  />
                </div>
                <Button
                  type="submit"
                  size="sm"
                  loading={busy === "payment"}
                  disabled={!amountValid || busy !== null}
                >
                  Record payment
                </Button>
              </form>
            ) : null}
          </Card>

          <Card className="gap-3 px-5 py-5">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-sm font-semibold">Invoices</h2>
              {order.status !== "cancelled" ? (
                <GatedControl
                  allowed={canInvoice}
                  upgradeMessage="Invoicing is a Premium feature."
                >
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    loading={busy === "invoice"}
                    onClick={() =>
                      void act("invoice", "/api/v1/invoices", {
                        orderId: order.id,
                        kind: "full",
                      })
                    }
                  >
                    <FileTextIcon /> Issue invoice
                  </Button>
                </GatedControl>
              ) : null}
            </div>
            {invoices === null ? (
              <p className="text-sm text-muted-foreground">Invoices are unavailable.</p>
            ) : invoices.length === 0 ? (
              <p className="text-sm text-muted-foreground">No invoice has been issued.</p>
            ) : (
              <ul className="flex flex-col divide-y">
                {invoices.map((invoice) => (
                  <li
                    key={invoice.id}
                    className="flex items-baseline justify-between gap-3 py-2"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{invoice.number}</span>
                      <span className="block text-xs text-muted-foreground capitalize">
                        {invoice.kind} · {invoice.status} · due {formatDate(invoice.dueAt)}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm font-medium tabular-nums">
                      {formatMoney(invoice.amountDueMinor, invoice.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card className="gap-3 px-5 py-5">
            <h2 className="text-sm font-semibold">Customer</h2>
            {order.customer ? (
              <>
                <div>
                  <Link
                    href={`/operations/customers/${order.customer.recordId}`}
                    className="text-base font-medium underline-offset-4 hover:underline"
                  >
                    {who}
                  </Link>
                  <ul className="mt-2 flex flex-col gap-1.5 text-sm">
                    {order.customer.email ? (
                      <li className="flex items-center gap-2">
                        <MailIcon className="size-4 text-muted-foreground" aria-hidden />
                        <a
                          href={`mailto:${order.customer.email}`}
                          className="truncate underline-offset-4 hover:underline"
                        >
                          {order.customer.email}
                        </a>
                      </li>
                    ) : null}
                    {order.customer.phone ? (
                      <li className="flex items-center gap-2">
                        <PhoneIcon className="size-4 text-muted-foreground" aria-hidden />
                        <a
                          href={`tel:${order.customer.phone}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {order.customer.phone}
                        </a>
                      </li>
                    ) : null}
                  </ul>
                </div>
                <Link
                  href={`/operations/customers/${order.customer.recordId}`}
                  className="text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  All orders from this customer →
                </Link>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No customer is attached to this order.
              </p>
            )}
          </Card>

          {order.answers.length > 0 ? (
            <Card className="gap-3 px-5 py-5">
              <h2 className="text-sm font-semibold">What they entered</h2>
              <dl className="flex flex-col gap-2.5 text-sm">
                {order.answers.map((answer) => (
                  <div key={answer.key}>
                    <dt className="text-xs text-muted-foreground">{answer.label}</dt>
                    <dd className="break-words whitespace-pre-wrap">{answer.value}</dd>
                  </div>
                ))}
              </dl>
              {order.customer ? (
                <Link
                  href={`/entities/${order.customer.entityId}`}
                  className="text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  Open the record →
                </Link>
              ) : null}
            </Card>
          ) : null}

          {order.notes ? (
            <Card className="gap-2 px-5 py-5">
              <h2 className="text-sm font-semibold">Notes</h2>
              <p className="text-sm whitespace-pre-wrap">{order.notes}</p>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/operations?tab=orders"
      className="flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeftIcon className="size-4" aria-hidden /> Orders
    </Link>
  );
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={strong ? "font-medium" : "text-muted-foreground"}>{label}</dt>
      <dd className={strong ? "font-semibold tabular-nums" : "tabular-nums"}>{value}</dd>
    </div>
  );
}
