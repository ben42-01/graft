"use client";

/**
 * Calendar widget (GRAFT-13 AC3) — highlights the dates an entity's records
 * carry in one configured date field, read live through the existing records
 * endpoint. Read-only: this is a summary view, not a scheduler.
 */
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Calendar } from "@/components/ui/calendar";
import { LoadingState } from "@/components/shell/loading-state";
import { ErrorState } from "@/components/shell/error-state";
import type { WidgetProps } from "@/lib/widgets/registry";

type RecordRow = { data: Record<string, unknown> };
type State = { status: "loading" } | { status: "error" } | { status: "ready"; dates: Date[] };

async function load(entityId: string, dateField: string): Promise<State> {
  try {
    const res = await fetch(`/api/v1/entities/${entityId}/records?limit=100`, {
      credentials: "include",
    });
    if (!res.ok) return { status: "error" };
    const body = (await res.json()) as { data: RecordRow[] };
    const dates = body.data
      .map((row) => row.data[dateField])
      .filter((value): value is string => typeof value === "string")
      .map((value) => new Date(value))
      .filter((date) => !Number.isNaN(date.getTime()));
    return { status: "ready", dates };
  } catch {
    return { status: "error" };
  }
}

export function CalendarWidget({ widget }: WidgetProps) {
  const config = widget.config as { entityId?: string; dateField?: string };
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    if (!config.entityId || !config.dateField) {
      setState({ status: "error" });
      return;
    }
    void load(config.entityId, config.dateField).then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, [config.entityId, config.dateField]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">Calendar</CardTitle>
      </CardHeader>
      <CardContent>
        {state.status === "loading" ? <LoadingState label="Loading dates…" /> : null}
        {state.status === "error" ? (
          <ErrorState description="We couldn't load this calendar." />
        ) : null}
        {state.status === "ready" ? (
          <Calendar mode="multiple" selected={state.dates} disabled className="p-0" />
        ) : null}
      </CardContent>
    </Card>
  );
}
