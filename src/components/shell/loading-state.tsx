/**
 * Shared loading-state primitive (GRAFT-11.5 AC1) — rendered while a screen's
 * data fetch is in flight. `role="status"` + `aria-live` so assistive tech
 * announces the wait without needing visual polling.
 */
import { Loader2Icon } from "lucide-react";

export function LoadingState({ label = "Loading…" }: { label?: string }) {
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
