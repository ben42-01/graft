/**
 * Shared error-state primitive (GRAFT-11.5 AC1, AC2). Takes only plain
 * strings — never an `Error`/`unknown` prop — so there is no code path by
 * which a raw stack trace or error object can reach the rendered UI
 * (docs/GO-LIVE.md §7). Callers translate whatever they caught into a safe
 * message before rendering this.
 */
import { AlertTriangleIcon } from "lucide-react";
import type { ReactNode } from "react";

export function ErrorState({
  title = "Something went wrong",
  description = "Please try again. If the problem persists, contact support.",
  action,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-12 text-center"
    >
      <AlertTriangleIcon className="size-8 text-destructive" aria-hidden="true" />
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
