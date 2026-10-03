"use client";

/**
 * The order form — for an order that did not come through a public form (a
 * phone call, a walk-in) and for correcting a draft before the customer is
 * asked for money.
 *
 * Three things matter enough to call out:
 *
 *   - **The server prices the order; this only previews it.** Lines go up as
 *     a description, a quantity and a unit price, and the amounts, the total
 *     and the deposit come back computed (`priceOrder`). The total shown while
 *     typing is a courtesy and is labelled as an estimate of nothing — it is
 *     simply the same arithmetic, and the saved order is what counts.
 *   - **A booked line is not editable here.** A line raised by a booking form
 *     carries the allocation that holds its capacity. Changing or removing it
 *     in a form would leave the capacity held for something the order no
 *     longer says; so those lines are shown, locked, and sent back untouched.
 *     Cancelling the order is what releases them.
 *   - **A discount is typed as a positive amount.** "10 off" is how a person
 *     says it; the sign is this form's business, not theirs.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { LockIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/bms/format";
import { getJson, type ApiCustomer } from "@/lib/bms/reads";
import { customerName } from "./customers-panel";

export const LINE_KINDS = ["resource", "addon", "fee", "discount"] as const;
export type LineKind = (typeof LINE_KINDS)[number];

const KIND_LABEL: Record<LineKind, string> = {
  resource: "Item",
  addon: "Add-on",
  fee: "Fee",
  discount: "Discount",
};

/** A line as the API returns it — the shape an edit starts from. */
export type ExistingLine = {
  kind: LineKind;
  description: string;
  quantity: number;
  unitAmountMinor: number;
  poolId?: string;
  allocationId?: string;
  recordId?: string;
};

export type EditorLine = {
  key: string;
  kind: LineKind;
  description: string;
  quantity: string;
  /** Major units, as typed. Always positive — see the module docs. */
  price: string;
  /** Set on a booked line: shown, never edited, sent back as it arrived. */
  locked: ExistingLine | null;
};

export type OrderDraft = {
  currency: string;
  customerRecordId: string;
  depositPercent: string;
  notes: string;
  lines: EditorLine[];
};

let nextKey = 0;
export const blankLine = (): EditorLine => ({
  key: `line-${(nextKey += 1)}`,
  kind: "resource",
  description: "",
  quantity: "1",
  price: "",
  locked: null,
});

export function toEditorLine(line: ExistingLine): EditorLine {
  return {
    key: `line-${(nextKey += 1)}`,
    kind: line.kind,
    description: line.description,
    quantity: String(line.quantity),
    price: (Math.abs(line.unitAmountMinor) / 100).toFixed(2),
    locked: line.allocationId ? line : null,
  };
}

const amount = (value: string) => Math.round(Number(value.replace(",", ".")) * 100);

/** What a line will be sent as, or the reason it cannot be. */
export function lineError(line: EditorLine): string | null {
  if (line.locked) return null;
  if (line.description.trim() === "") return "Describe the item";
  const quantity = Number(line.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) return "Quantity must be a whole number";
  const minor = amount(line.price);
  if (line.price.trim() === "" || !Number.isFinite(minor) || minor < 0) return "Enter a price";
  return null;
}

export function toLineInput(line: EditorLine) {
  if (line.locked) {
    const { kind, description, quantity, unitAmountMinor, poolId, allocationId, recordId } =
      line.locked;
    return {
      kind,
      description,
      quantity,
      unitAmountMinor,
      ...(poolId ? { poolId } : {}),
      ...(allocationId ? { allocationId } : {}),
      ...(recordId ? { recordId } : {}),
    };
  }
  const minor = amount(line.price);
  return {
    kind: line.kind,
    description: line.description.trim(),
    quantity: Number(line.quantity),
    unitAmountMinor: line.kind === "discount" ? -minor : minor,
  };
}

/** The same sum the server does, for the running total under the lines. */
export function previewTotal(lines: EditorLine[]): number {
  let total = 0;
  for (const line of lines) {
    if (lineError(line)) continue;
    const input = toLineInput(line);
    total += input.quantity * input.unitAmountMinor;
  }
  return Math.max(0, total);
}

const selectClass =
  "h-9 rounded-md border bg-background px-2 text-sm focus-visible:ring-2 focus-visible:ring-graft-green focus-visible:outline-none";

export function OrderEditor({
  initial,
  mode,
  backHref,
  onSubmit,
}: {
  initial: OrderDraft;
  /** A new order chooses its currency and deposit; an edit inherits both. */
  mode: "create" | "edit";
  backHref: string;
  /** Resolves to an error message, or null when the order was saved. */
  onSubmit: (draft: OrderDraft) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState<OrderDraft>(initial);
  const [customers, setCustomers] = useState<ApiCustomer[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getJson<ApiCustomer[]>("/api/v1/customers?limit=100").then((list) => {
      if (!cancelled) setCustomers(list ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // An order points at one record; a customer may have several. The select
  // works in customer ids, so the order's own record is mapped onto whichever
  // customer owns it.
  const selectedCustomer = useMemo(() => {
    if (!draft.customerRecordId) return "";
    const owner = customers?.find((customer) =>
      customer.recordIds.includes(draft.customerRecordId),
    );
    return owner?.id ?? draft.customerRecordId;
  }, [customers, draft.customerRecordId]);

  const patchLine = (key: string, patch: Partial<EditorLine>) =>
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    }));

  const currency = draft.currency.trim().toUpperCase();
  const currencyValid = /^[A-Z]{3}$/.test(currency);
  const deposit = draft.depositPercent.trim() === "" ? null : Number(draft.depositPercent);
  const depositValid =
    deposit === null || (Number.isInteger(deposit) && deposit >= 0 && deposit <= 100);
  const valid =
    draft.lines.length > 0 &&
    draft.lines.every((line) => lineError(line) === null) &&
    currencyValid &&
    depositValid;

  async function submit() {
    setShowErrors(true);
    if (!valid) return;
    setSaving(true);
    setError(null);
    const failure = await onSubmit({ ...draft, currency });
    // On success the caller navigates away, so the button stays busy.
    if (failure) {
      setError(failure);
      setSaving(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Card className="gap-4 px-5 py-5">
        <h2 className="text-sm font-semibold">Customer</h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="order-customer">Who is it for?</Label>
          <select
            id="order-customer"
            value={selectedCustomer}
            onChange={(event) =>
              setDraft((current) => ({ ...current, customerRecordId: event.target.value }))
            }
            className={`${selectClass} max-w-md`}
          >
            <option value="">No customer</option>
            {(customers ?? []).map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customerName(customer)}
                {customer.name && customer.email ? ` — ${customer.email}` : ""}
              </option>
            ))}
            {/* Until the list has loaded, keep the order's own customer selected. */}
            {selectedCustomer && !customers?.some((c) => c.id === selectedCustomer) ? (
              <option value={selectedCustomer}>Current customer</option>
            ) : null}
          </select>
          <p className="text-xs text-muted-foreground">
            Anyone who has ordered before is listed. For someone new, leave this empty and put
            their name in the notes.
          </p>
        </div>
      </Card>

      <Card className="gap-4 px-5 py-5">
        <h2 className="text-sm font-semibold">Items</h2>
        <ul className="flex flex-col gap-3">
          {draft.lines.map((line, index) => {
            const problem = showErrors ? lineError(line) : null;
            const n = index + 1;
            return (
              <li key={line.key} className="flex flex-col gap-1.5">
                {line.locked ? (
                  <div className="flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <LockIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate">
                        {line.locked.quantity} × {line.description}
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {formatMoney(
                        line.locked.quantity * line.locked.unitAmountMinor,
                        currency,
                      )}
                    </span>
                  </div>
                ) : (
                  <div className="grid grid-cols-[4.5rem_1fr_auto] gap-2 sm:grid-cols-[7rem_1fr_5rem_7rem_auto]">
                    <select
                      value={line.kind}
                      onChange={(event) =>
                        patchLine(line.key, { kind: event.target.value as LineKind })
                      }
                      aria-label={`Line ${n} type`}
                      className={`${selectClass} col-span-3 sm:col-span-1`}
                    >
                      {LINE_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {KIND_LABEL[kind]}
                        </option>
                      ))}
                    </select>
                    <Input
                      value={line.description}
                      onChange={(event) =>
                        patchLine(line.key, { description: event.target.value })
                      }
                      placeholder="What is it?"
                      aria-label={`Line ${n} description`}
                      maxLength={200}
                      className="col-span-3 sm:col-span-1"
                    />
                    <Input
                      value={line.quantity}
                      onChange={(event) =>
                        patchLine(line.key, { quantity: event.target.value })
                      }
                      inputMode="numeric"
                      aria-label={`Line ${n} quantity`}
                    />
                    <Input
                      value={line.price}
                      onChange={(event) => patchLine(line.key, { price: event.target.value })}
                      inputMode="decimal"
                      placeholder={line.kind === "discount" ? "Amount off" : "Unit price"}
                      aria-label={`Line ${n} ${line.kind === "discount" ? "amount off" : "unit price"}`}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove line ${n}`}
                      disabled={draft.lines.length === 1}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          lines: current.lines.filter((other) => other.key !== line.key),
                        }))
                      }
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                )}
                {problem ? <p className="text-xs text-destructive">{problem}</p> : null}
              </li>
            );
          })}
        </ul>

        {draft.lines.some((line) => line.locked) ? (
          <p className="text-xs text-muted-foreground">
            Booked items hold capacity and cannot be changed here. Cancel the order to release
            them.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setDraft((current) => ({ ...current, lines: [...current.lines, blankLine()] }))
            }
          >
            <PlusIcon /> Add a line
          </Button>
          <p className="text-sm">
            <span className="text-muted-foreground">Total </span>
            <span className="font-semibold tabular-nums">
              {formatMoney(previewTotal(draft.lines), currencyValid ? currency : null)}
            </span>
          </p>
        </div>
      </Card>

      <Card className="gap-4 px-5 py-5">
        <h2 className="text-sm font-semibold">Details</h2>
        {mode === "create" ? (
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="order-currency">Currency</Label>
              <Input
                id="order-currency"
                value={draft.currency}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, currency: event.target.value }))
                }
                maxLength={3}
                className="w-24 uppercase"
                aria-invalid={showErrors && !currencyValid}
              />
              {showErrors && !currencyValid ? (
                <p className="text-xs text-destructive">A 3-letter code, like EUR</p>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="order-deposit">Deposit to confirm (%)</Label>
              <Input
                id="order-deposit"
                value={draft.depositPercent}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, depositPercent: event.target.value }))
                }
                inputMode="numeric"
                placeholder="None"
                className="w-32"
                aria-invalid={showErrors && !depositValid}
              />
              {showErrors && !depositValid ? (
                <p className="text-xs text-destructive">A whole number from 0 to 100</p>
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="order-notes">Notes</Label>
          <textarea
            id="order-notes"
            value={draft.notes}
            onChange={(event) =>
              setDraft((current) => ({ ...current, notes: event.target.value }))
            }
            rows={3}
            maxLength={2000}
            placeholder="Anything the person fulfilling this should know"
            className="rounded-md border bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-graft-green focus-visible:outline-none"
          />
        </div>
      </Card>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" loading={saving}>
          {mode === "create" ? "Create order" : "Save changes"}
        </Button>
        <Button asChild variant="ghost">
          <Link href={backHref}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}

/** Sends the draft and reports the server's own reason when it refuses. */
export async function saveOrder(
  method: "POST" | "PATCH",
  url: string,
  body: unknown,
): Promise<{ id: string } | { error: string }> {
  const fallback = "We couldn't save that order. Please try again.";
  try {
    const response = await fetch(url, {
      method,
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = (await response.json().catch(() => null)) as {
      data?: { id: string };
      error?: { message?: string };
    } | null;
    if (response.ok && parsed?.data) return { id: parsed.data.id };
    return { error: parsed?.error?.message ?? fallback };
  } catch {
    return { error: fallback };
  }
}
