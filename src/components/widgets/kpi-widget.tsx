"use client";

/**
 * KPI widget (GRAFT-13 AC3) — bound to either a usage meter or an entity's
 * record count, both read through existing APIs (no privileged data path):
 * `GET /api/v1/meters/:meter` or `GET /api/v1/entities/:entityId/records`.
 */
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { WidgetProps } from "@/lib/widgets/registry";

type KpiConfig = { source?: string; meter?: string; entityId?: string; label?: string };

async function readValue(config: KpiConfig): Promise<string> {
  try {
    if (config.source === "meter" && config.meter) {
      const res = await fetch(`/api/v1/meters/${config.meter}`, { credentials: "include" });
      if (!res.ok) return "—";
      const body = (await res.json()) as { data: { used: number; limit: number | null } };
      return body.data.limit === null
        ? `${body.data.used}`
        : `${body.data.used} / ${body.data.limit}`;
    }
    if (config.source === "count" && config.entityId) {
      const res = await fetch(`/api/v1/entities/${config.entityId}/records?limit=100`, {
        credentials: "include",
      });
      if (!res.ok) return "—";
      const body = (await res.json()) as { data: unknown[]; meta: { hasMore: boolean } };
      return `${body.data.length}${body.meta.hasMore ? "+" : ""}`;
    }
    return "—";
  } catch {
    return "—";
  }
}

export function KpiWidget({ widget }: WidgetProps) {
  const config = widget.config as KpiConfig;
  const [value, setValue] = useState("…");

  useEffect(() => {
    let cancelled = false;
    void readValue(config).then((v) => {
      if (!cancelled) setValue(v);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- config is a plain JSON bag, not identity-stable
  }, [config.source, config.meter, config.entityId]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {config.label ?? "KPI"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}
