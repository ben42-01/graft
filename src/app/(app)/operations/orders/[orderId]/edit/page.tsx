"use client";

/**
 * Editing a draft order — its lines, its customer, its notes. Only a draft:
 * once a customer has been asked for money the lines are what they agreed to,
 * and the server refuses the edit (`updateOrder`). The screen says so rather
 * than offering a form that cannot be saved.
 */
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftIcon } from "lucide-react";
import { ErrorState } from "@/components/shell/error-state";
import { LoadingState } from "@/components/shell/loading-state";
import {
  OrderEditor,
  saveOrder,
  toEditorLine,
  toLineInput,
  type ExistingLine,
  type OrderDraft,
} from "@/components/operations/order-editor";
import { orderNumber } from "@/lib/bms/format";
import { getJson } from "@/lib/bms/reads";

type Order = {
  id: string;
  status: string;
  currency: string;
  customerRecordId: string | null;
  notes: string | null;
  lineItems: ExistingLine[];
};

type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "locked" }
  | { status: "ready"; initial: OrderDraft };

export default function EditOrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = use(params);
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "loading" });
  const back = `/operations/orders/${orderId}`;

  useEffect(() => {
    let cancelled = false;
    void getJson<Order>(`/api/v1/orders/${orderId}`).then((order) => {
      if (cancelled) return;
      if (!order) return setState({ status: "error" });
      if (order.status !== "draft") return setState({ status: "locked" });
      setState({
        status: "ready",
        initial: {
          currency: order.currency,
          customerRecordId: order.customerRecordId ?? "",
          depositPercent: "",
          notes: order.notes ?? "",
          lines: order.lineItems.map(toEditorLine),
        },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <Link
        href={back}
        className="flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" aria-hidden /> Order {orderNumber(orderId)}
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">Edit order</h1>

      {state.status === "loading" ? <LoadingState label="Loading order…" /> : null}
      {state.status === "error" ? (
        <ErrorState description="We couldn't find that order." />
      ) : null}
      {state.status === "locked" ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
          Only a draft order can be edited. Once payment has been asked for, cancel the order
          and raise a new one.
        </p>
      ) : null}
      {state.status === "ready" ? (
        <OrderEditor
          mode="edit"
          initial={state.initial}
          backHref={back}
          onSubmit={async (draft) => {
            const result = await saveOrder("PATCH", `/api/v1/orders/${orderId}`, {
              lineItems: draft.lines.map(toLineInput),
              notes: draft.notes.trim(),
              ...(draft.customerRecordId ? { customerRecordId: draft.customerRecordId } : {}),
            });
            if ("error" in result) return result.error;
            router.push(back);
            return null;
          }}
        />
      ) : null}
    </div>
  );
}
