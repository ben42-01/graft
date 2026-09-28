/**
 * Shared loading-state primitive (GRAFT-11.5 AC1) — rendered while a screen's
 * data fetch is in flight. `role="status"` + `aria-live` so assistive tech
 * announces the wait without needing visual polling.
 *
 * Variants: `spinner` (the default — small regions, widgets, redirects),
 * `list` (skeleton rows where a list is about to appear) and `page` (a title
 * bar plus rows, for a whole screen). The skeletons lay the screen out before
 * its data arrives, so the wait reads as "filling in" rather than "stuck";
 * the label stays in the DOM for screen readers either way.
 */
import { Loader2Icon } from "lucide-react";

type Variant = "spinner" | "list" | "page";

function SkeletonRows({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 rounded-lg border border-border p-4"
        >
          <span className="size-8 shrink-0 animate-pulse rounded-md bg-muted" />
          <span className="flex flex-1 flex-col gap-2">
            <span
              className="h-3.5 animate-pulse rounded bg-muted"
              style={{ width: `${60 - (index % 3) * 12}%` }}
            />
            <span className="h-3 w-1/3 animate-pulse rounded bg-muted" />
          </span>
        </div>
      ))}
    </div>
  );
}

export function LoadingState({
  label = "Loading…",
  variant = "spinner",
}: {
  label?: string;
  variant?: Variant;
}) {
  if (variant === "spinner") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center"
      >
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">{label}</p>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-variant={variant}
      className={variant === "page" ? "flex flex-col gap-6 p-6" : "flex flex-col"}
    >
      <span className="sr-only">{label}</span>
      {variant === "page" ? (
        <div className="flex flex-col gap-2" aria-hidden="true">
          <span className="h-6 w-48 animate-pulse rounded bg-muted" />
          <span className="h-4 w-72 max-w-full animate-pulse rounded bg-muted" />
        </div>
      ) : null}
      <div aria-hidden="true">
        <SkeletonRows rows={variant === "page" ? 5 : 3} />
      </div>
    </div>
  );
}
