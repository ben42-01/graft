"use client";

/**
 * Record List widget (GRAFT-13 AC3) — a table bound to one entity, reading
 * live tenant data through the existing entity/record endpoints: the entity
 * for its field labels, then its records. No privileged data path.
 */
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/shell/loading-state";
import { EmptyState } from "@/components/shell/empty-state";
import { ErrorState } from "@/components/shell/error-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { WidgetProps } from "@/lib/widgets/registry";

type FieldDef = { key: string; label: string };
type RecordRow = { id: string; data: Record<string, unknown> };
type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; fields: FieldDef[]; rows: RecordRow[] };

async function load(entityId: string, limit: number): Promise<State> {
  try {
    const [entityRes, recordsRes] = await Promise.all([
      fetch(`/api/v1/entities/${entityId}`, { credentials: "include" }),
      fetch(`/api/v1/entities/${entityId}/records?limit=${limit}`, { credentials: "include" }),
    ]);
    if (!entityRes.ok || !recordsRes.ok) return { status: "error" };
    const entity = (await entityRes.json()) as { data: { fields: FieldDef[] } };
    const records = (await recordsRes.json()) as { data: RecordRow[] };
    return { status: "ready", fields: entity.data.fields, rows: records.data };
  } catch {
    return { status: "error" };
  }
}

export function RecordListWidget({ widget }: WidgetProps) {
  const config = widget.config as { entityId?: string; limit?: number };
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    if (!config.entityId) {
      setState({ status: "error" });
      return;
    }
    void load(config.entityId, config.limit ?? 10).then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, [config.entityId, config.limit]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">Record List</CardTitle>
      </CardHeader>
      <CardContent>
        {state.status === "loading" ? <LoadingState label="Loading records…" /> : null}
        {state.status === "error" ? (
          <ErrorState description="We couldn't load these records." />
        ) : null}
        {state.status === "ready" && state.rows.length === 0 ? (
          <EmptyState title="No records yet" />
        ) : null}
        {state.status === "ready" && state.rows.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                {state.fields.map((field) => (
                  <TableHead key={field.key}>{field.label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.rows.map((row) => (
                <TableRow key={row.id}>
                  {state.fields.map((field) => (
                    <TableCell key={field.key}>{String(row.data[field.key] ?? "")}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </CardContent>
    </Card>
  );
}
