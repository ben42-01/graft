"use client";

/**
 * A new order, entered by hand — the phone call and the walk-in. Until this
 * screen an order could only be raised by a public form or through the API,
 * so a business taking orders any other way had nowhere to put them.
 *
 * It is created as a `draft`, exactly as a form's is, and lands on its own
 * page where it can be moved on, paid and invoiced like any other.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftIcon } from "lucide-react";
import { LoadingState } from "@/components/shell/loading-state";
import {
  blankLine,
  OrderEditor,
  saveOrder,
  toLineInput,
  type OrderDraft,
} from "@/components/operations/order-editor";
import { getJson, type ApiBusinessSummary } from "@/lib/bms/reads";

/** What a tenant that has never taken an order starts from. */
const FALLBACK_CURRENCY = "EUR";

export default function NewOrderPage() {
  const router = useRouter();
  const [initial, setInitial] = useState<OrderDraft | null>(null);

  useEffect(() => {
    let cancelled = false;
    // The currency the tenant already trades in, so it is not retyped per order.
    void getJson<ApiBusinessSummary>("/api/v1/reports/summary").then((summary) => {
      if (cancelled) return;
      setInitial({
        currency: summary?.currency ?? FALLBACK_CURRENCY,
        customerRecordId: "",
        depositPercent: "",
        notes: "",
        lines: [blankLine()],
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <Link
        href="/operations?tab=orders"
        className="flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" aria-hidden /> Orders
      </Link>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New order</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          For an order taken by phone or in person. It starts as a draft.
        </p>
      </div>

      {initial ? (
        <OrderEditor
          mode="create"
          initial={initial}
          backHref="/operations?tab=orders"
          onSubmit={async (draft) => {
            const result = await saveOrder("POST", "/api/v1/orders", {
              currency: draft.currency,
              lineItems: draft.lines.map(toLineInput),
              ...(draft.customerRecordId ? { customerRecordId: draft.customerRecordId } : {}),
              ...(draft.depositPercent.trim() !== "" && Number(draft.depositPercent) > 0
                ? { deposit: { percent: Number(draft.depositPercent) } }
                : {}),
              ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
            });
            if ("error" in result) return result.error;
            router.push(`/operations/orders/${result.id}`);
            return null;
          }}
        />
      ) : (
        <LoadingState label="Loading…" />
      )}
    </div>
  );
}
