"use client";

/**
 * Chart widget (GRAFT-13 AC3, AC5) — Premium+ (docs/TIERS.md §2.4 Reports).
 * `canUseChart` comes from the same `/me`-shaped tier the rest of the app
 * already gates on (src/app/(app)/page.tsx), so a Free tenant sees a locked
 * card via `GatedControl` and never issues the request at all; the request
 * itself is refused server-side regardless (`GET /api/v1/reports/usage`,
 * src/server/services/reports.ts) — the lock is not client-only.
 *
 * No charting dependency is added for one bar: a tiny inline SVG renders
 * used/limit, which is all the MVP report needs (see PR "Outside guidance").
 */
import { useEffect, useState } from "react";
import { LockIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/shell/loading-state";
import { ErrorState } from "@/components/shell/error-state";
import type { WidgetProps } from "@/lib/widgets/registry";

type Usage = { used: number; limit: number | null };
type State = { status: "loading" } | { status: "error" } | { status: "ready"; usage: Usage };

async function load(meter: string): Promise<State> {
  try {
    const res = await fetch(`/api/v1/reports/usage?meter=${meter}`, { credentials: "include" });
    if (!res.ok) return { status: "error" };
    const body = (await res.json()) as { data: Usage };
    return { status: "ready", usage: body.data };
  } catch {
    return { status: "error" };
  }
}

export function ChartWidget({ widget, canUseChart }: WidgetProps) {
  const config = widget.config as { meter?: string; label?: string };
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    if (!canUseChart || !config.meter) return;
    void load(config.meter).then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, [canUseChart, config.meter]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {config.label ?? "Chart"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!canUseChart ? (
          <div className="flex flex-col items-start gap-1.5">
            <div className="flex h-24 w-full items-center justify-center rounded-md border border-dashed">
              <LockIcon className="size-5 text-muted-foreground" aria-hidden="true" />
            </div>
            <p className="text-xs text-muted-foreground">
              Upgrade to Premium to unlock the Chart widget.
            </p>
          </div>
        ) : null}
        {canUseChart && state.status === "loading" ? (
          <LoadingState label="Loading chart…" />
        ) : null}
        {canUseChart && state.status === "error" ? (
          <ErrorState description="We couldn't load this chart." />
        ) : null}
        {canUseChart && state.status === "ready" ? (
          <UsageBar used={state.usage.used} limit={state.usage.limit} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function UsageBar({ used, limit }: Usage) {
  const ratio = limit === null || limit === 0 ? 0 : Math.min(1, used / limit);
  return (
    <svg
      viewBox="0 0 100 24"
      className="h-6 w-full"
      role="img"
      aria-label={`${used} of ${limit ?? "unlimited"} used`}
    >
      <rect x={0} y={0} width={100} height={24} rx={4} className="fill-muted" />
      <rect x={0} y={0} width={ratio * 100} height={24} rx={4} className="fill-primary" />
    </svg>
  );
}
