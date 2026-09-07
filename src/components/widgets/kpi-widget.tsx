"use client";

/**
 * KPI widget (GRAFT-13 AC3) — bound to either a usage meter or an entity's
 * record count, both read through existing APIs (no privileged data path):
 * `GET /api/v1/meters/:meter` or `GET /api/v1/entities/:entityId/records`.
 *
 * 2026-08-21 UI refinement — a meter KPI used to render the bare string
 * "0 / 200", which reads as a fraction with no indication of *what* it
 * measures or how close to the limit it is. The reading is now structured
 * (`{ used, limit }` rather than a pre-formatted string) so the card can show
 * the number at full size, the ceiling as a caption, and a bar for the ratio
 * — and so "unlimited" (`limit === null`) is branched on, never compared.
 */
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { WidgetProps } from "@/lib/widgets/registry";

type KpiConfig = { source?: string; meter?: string; entityId?: string; label?: string };

type Reading =
  | { status: "loading" }
  | { status: "unavailable" }
  /** `limit: null` is unlimited; `approx` marks a page-capped count. */
  | { status: "ready"; used: number; limit: number | null; approx?: boolean };

async function readValue(config: KpiConfig): Promise<Reading> {
  try {
    if (config.source === "meter" && config.meter) {
      const res = await fetch(`/api/v1/meters/${config.meter}`, { credentials: "include" });
      if (!res.ok) return { status: "unavailable" };
      const body = (await res.json()) as { data: { used: number; limit: number | null } };
      return { status: "ready", used: body.data.used, limit: body.data.limit };
    }
    if (config.source === "count" && config.entityId) {
      const res = await fetch(`/api/v1/entities/${config.entityId}/records?limit=100`, {
        credentials: "include",
      });
      if (!res.ok) return { status: "unavailable" };
      const body = (await res.json()) as { data: unknown[]; meta: { hasMore: boolean } };
      return {
        status: "ready",
        used: body.data.length,
        limit: null,
        approx: body.meta.hasMore,
      };
    }
    return { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

export function KpiWidget({ widget }: WidgetProps) {
  const config = widget.config as KpiConfig;
  const [reading, setReading] = useState<Reading>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void readValue(config).then((value) => {
      if (!cancelled) setReading(value);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- config is a plain JSON bag, not identity-stable
  }, [config.source, config.meter, config.entityId]);

  const ratio =
    reading.status === "ready" && reading.limit !== null && reading.limit > 0
      ? Math.min(1, reading.used / reading.limit)
      : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {config.label ?? "KPI"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {reading.status === "loading" ? (
          <p className="text-3xl font-semibold tabular-nums text-muted-foreground">…</p>
        ) : null}

        {reading.status === "unavailable" ? (
          <>
            <p className="text-3xl font-semibold tabular-nums text-muted-foreground">—</p>
            <p className="mt-1 text-xs text-muted-foreground">No reading available.</p>
          </>
        ) : null}

        {reading.status === "ready" ? (
          <>
            <p className="flex items-baseline gap-1.5">
              <span className="text-3xl font-semibold tabular-nums">
                {reading.used.toLocaleString()}
                {reading.approx ? "+" : ""}
              </span>
              {reading.limit !== null ? (
                <span className="text-sm text-muted-foreground tabular-nums">
                  of {reading.limit.toLocaleString()}
                </span>
              ) : null}
            </p>

            {ratio !== null ? (
              <>
                <div
                  className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-valuenow={Math.round(ratio * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${config.label ?? "KPI"} usage`}
                >
                  {/* Amber past the 80% quota-warning ratio, red at the
                   * ceiling — same thresholds meters.ts warns on. */}
                  <div
                    className={cn(
                      "h-full rounded-full transition-[width]",
                      ratio >= 1
                        ? "bg-destructive"
                        : ratio >= 0.8
                          ? "bg-graft-warn"
                          : "bg-graft-green",
                    )}
                    style={{ width: `${ratio * 100}%` }}
                  />
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {Math.round(ratio * 100)}% of your plan&apos;s limit used
                </p>
              </>
            ) : null}

            {reading.limit === null ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {reading.approx ? "First 100 records counted" : "No limit on your plan"}
              </p>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
