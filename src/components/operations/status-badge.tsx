import { cn } from "@/lib/utils";
import { STATUS_LABEL, type OrderStatus } from "./order-board";

/**
 * An order's status as a pill. The word is always there — the tint only
 * groups, so the status reads the same with colour switched off. Same
 * reasoning as the board's column accents: cancelled is an ordinary outcome,
 * not an error, so it is muted rather than red.
 */
const TINT: Record<OrderStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  pending_payment: "bg-amber-100 text-amber-900 dark:bg-amber-400/15 dark:text-amber-200",
  confirmed: "bg-graft-green/10 text-graft-green-deep dark:text-graft-green-light",
  in_progress: "bg-graft-indigo/10 text-graft-indigo dark:text-indigo-300",
  completed: "bg-graft-green/10 text-graft-green-deep dark:text-graft-green-light",
  cancelled: "bg-muted text-muted-foreground line-through",
};

export function StatusBadge({
  status,
  className,
}: {
  status: OrderStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        TINT[status],
        className,
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
