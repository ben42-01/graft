/**
 * Shared empty-state primitive (GRAFT-11.5 AC1) — a screen renders this when
 * a fetch succeeded but returned nothing, distinct from `LoadingState`
 * (still fetching) and `ErrorState` (fetch failed).
 */
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { InboxIcon } from "lucide-react";

export function EmptyState({
  icon: Icon = InboxIcon,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-12 text-center">
      <Icon className="size-8 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? (
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
