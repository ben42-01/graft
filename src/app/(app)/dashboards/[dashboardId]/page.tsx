"use client";

/**
 * Dashboard composer (GRAFT-13 AC4) — a fixed 2-column grid. Adding, moving
 * (drag-and-drop) and removing a widget all end in the same place: the whole
 * `widgets` array is replaced with one `PATCH /api/v1/dashboards/:id`, so a
 * reload always reads back exactly what was last saved (AC1 — pure JSON, no
 * component identity persisted).
 */
import { useEffect, useState, type DragEvent } from "react";
import { useParams } from "next/navigation";
import { PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LoadingState } from "@/components/shell/loading-state";
import { ErrorState } from "@/components/shell/error-state";
import { resolveWidget, WIDGET_CATALOG } from "@/lib/widgets/registry";
import type { DashboardView, WidgetInstance } from "@/lib/widgets/types";
import { useMe } from "@/lib/session";

const GRID_COLUMNS = 2;

function layoutFor(index: number) {
  return { x: index % GRID_COLUMNS, y: Math.floor(index / GRID_COLUMNS), w: 1, h: 1 };
}

/** Re-derives layout from array order — order is the only thing "move" changes. */
function relaid(widgets: WidgetInstance[]): WidgetInstance[] {
  return widgets.map((widget, index) => ({ ...widget, layout: layoutFor(index) }));
}

function newWidgetId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `widget-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

type State =
  { status: "loading" } | { status: "error" } | { status: "ready"; dashboard: DashboardView };

async function fetchDashboard(id: string): Promise<State> {
  try {
    const res = await fetch(`/api/v1/dashboards/${id}`, { credentials: "include" });
    if (!res.ok) return { status: "error" };
    const body = (await res.json()) as { data: DashboardView };
    return { status: "ready", dashboard: body.data };
  } catch {
    return { status: "error" };
  }
}

async function saveWidgets(
  id: string,
  widgets: WidgetInstance[],
): Promise<DashboardView | null> {
  try {
    const res = await fetch(`/api/v1/dashboards/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ widgets }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data: DashboardView };
    return body.data;
  } catch {
    return null;
  }
}

/** The config a new widget of `type` starts with — enough to be valid per its
 * schema (src/server/services/dashboards.ts); the user edits fields inline. */
function defaultConfig(type: string): Record<string, unknown> {
  switch (type) {
    case "kpi":
      return { source: "meter", meter: "records", label: "Records used" };
    case "chart":
      return { meter: "records", label: "Records usage" };
    case "calendar":
      return { entityId: "", dateField: "" };
    default:
      return { entityId: "" };
  }
}

export default function DashboardComposerPage() {
  const params = useParams<{ dashboardId: string }>();
  const { me } = useMe();
  const [state, setState] = useState<State>({ status: "loading" });
  const [addingType, setAddingType] = useState<string>(WIDGET_CATALOG[0].type);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  useEffect(() => {
    void fetchDashboard(params.dashboardId).then(setState);
  }, [params.dashboardId]);

  const canUseChart = me ? me.tenant.tier !== "free" : false;

  async function persist(widgets: WidgetInstance[]) {
    if (state.status !== "ready") return;
    const relaidWidgets = relaid(widgets);
    setState({ status: "ready", dashboard: { ...state.dashboard, widgets: relaidWidgets } });
    const saved = await saveWidgets(params.dashboardId, relaidWidgets);
    if (saved) setState({ status: "ready", dashboard: saved });
  }

  function addWidget() {
    if (state.status !== "ready") return;
    const widget: WidgetInstance = {
      id: newWidgetId(),
      type: addingType,
      config: defaultConfig(addingType),
      layout: layoutFor(state.dashboard.widgets.length),
    };
    void persist([...state.dashboard.widgets, widget]);
  }

  function removeWidget(id: string) {
    if (state.status !== "ready") return;
    void persist(state.dashboard.widgets.filter((w) => w.id !== id));
  }

  function onDrop(targetIndex: number) {
    if (state.status !== "ready" || dragIndex === null || dragIndex === targetIndex) return;
    const widgets = [...state.dashboard.widgets];
    const [moved] = widgets.splice(dragIndex, 1);
    if (moved) widgets.splice(targetIndex, 0, moved);
    setDragIndex(null);
    void persist(widgets);
  }

  if (state.status === "loading") return <LoadingState label="Loading dashboard…" />;
  if (state.status === "error") {
    return <ErrorState description="We couldn't load this dashboard." />;
  }

  const { dashboard } = state;

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-semibold tracking-tight">{dashboard.name}</h1>

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor="widget-type" className="mb-1 block text-xs">
            Widget type
          </Label>
          <Select value={addingType} onValueChange={setAddingType}>
            <SelectTrigger id="widget-type" aria-label="Widget type" size="sm" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WIDGET_CATALOG.map((entry) => (
                <SelectItem key={entry.type} value={entry.type}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="button" size="sm" onClick={addWidget}>
          <PlusIcon /> Add widget
        </Button>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2" data-testid="widgets-grid">
        {dashboard.widgets.map((widget, index) => {
          const WidgetComponent = resolveWidget(widget.type);
          return (
            <div
              key={widget.id}
              draggable
              data-testid={`widget-${widget.id}`}
              onDragStart={() => setDragIndex(index)}
              onDragOver={(event: DragEvent) => event.preventDefault()}
              onDrop={() => onDrop(index)}
              className="relative"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Remove widget"
                className="absolute top-2 right-2 z-10"
                onClick={() => removeWidget(widget.id)}
              >
                <XIcon />
              </Button>
              <WidgetComponent widget={widget} canUseChart={canUseChart} />
            </div>
          );
        })}
      </div>
      {dashboard.widgets.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          No widgets yet — add one above to start building this dashboard.
        </p>
      ) : null}
    </div>
  );
}
