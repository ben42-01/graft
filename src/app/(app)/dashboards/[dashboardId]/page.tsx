"use client";

/**
 * Dashboard composer (GRAFT-13 AC4) — a fixed 2-column grid. Adding, moving
 * (drag-and-drop) and removing a widget all end in the same place: the whole
 * `widgets` array is replaced with one `PATCH /api/v1/dashboards/:id`, so a
 * reload always reads back exactly what was last saved (AC1 — pure JSON, no
 * component identity persisted).
 *
 * 2026-08-21 UI refinement — the "Add widget" flow used to post a *stub*
 * config (`{ entityId: "" }` for Record List, `{ entityId: "", dateField: ""
 * }` for Calendar). Those fail the server's widget config schema
 * (src/server/services/dashboards.ts — `entityId` must be a 24-char ObjectId),
 * so every Record List and Calendar add answered 400 VALIDATION_FAILED while
 * the optimistic update left a broken card on screen that vanished on reload.
 * Two changes fix that class of bug rather than the two instances:
 *
 *   1. A widget is configured *before* it is added. The picker asks for
 *      whatever the chosen type's schema requires — an entity, a date field,
 *      a metric — and "Add widget" stays disabled until the config it would
 *      send is actually valid. There is no longer a code path that posts a
 *      placeholder id.
 *   2. A failed save rolls the optimistic state back and surfaces the API's
 *      own message, instead of leaving the UI showing something the server
 *      rejected.
 */
import { useEffect, useMemo, useState, type DragEvent } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { WIDGET_METERS, meterLabel } from "@/lib/widgets/meters";
import type { DashboardView, WidgetInstance } from "@/lib/widgets/types";
import { useMe } from "@/lib/session";

const GRID_COLUMNS = 2;

/** Mirrors `fieldDefSchema.type` (src/server/services/entities.ts) for the
 * one thing the Calendar widget needs to know: which fields hold a date. */
type EntityOption = {
  id: string;
  name: string;
  fields: { key: string; label: string; type: string }[];
};

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

async function fetchEntities(): Promise<EntityOption[]> {
  try {
    const res = await fetch("/api/v1/entities", { credentials: "include" });
    if (!res.ok) return [];
    const body = (await res.json()) as { data: EntityOption[] };
    return body.data;
  } catch {
    return [];
  }
}

type SaveResult = { ok: true; dashboard: DashboardView } | { ok: false; message: string };

async function saveWidgets(id: string, widgets: WidgetInstance[]): Promise<SaveResult> {
  try {
    const res = await fetch(`/api/v1/dashboards/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ widgets }),
    });
    const body = (await res.json().catch(() => null)) as
      { data: DashboardView } | { error: { code: string; message: string } } | null;
    if (!res.ok || !body || "error" in body) {
      return {
        ok: false,
        message:
          body && "error" in body ? body.error.message : "We couldn't save this dashboard.",
      };
    }
    return { ok: true, dashboard: body.data };
  } catch {
    return { ok: false, message: "Network error. Try again." };
  }
}

/** The draft a new widget is built from — one flat bag covering every type,
 * narrowed into a per-type config by `buildConfig`. */
type Draft = {
  entityId: string;
  dateField: string;
  meter: string;
  source: "meter" | "count";
  label: string;
};

const EMPTY_DRAFT: Draft = {
  entityId: "",
  dateField: "",
  meter: "records",
  source: "meter",
  label: "",
};

/**
 * The config to POST for `type`, or `null` when the draft is not complete
 * enough to be valid. Mirrors `WIDGET_CONFIG_SCHEMAS`
 * (src/server/services/dashboards.ts) — the server is still the authority;
 * this only keeps the UI from ever asking for something it knows is invalid.
 */
function buildConfig(type: string, draft: Draft): Record<string, unknown> | null {
  switch (type) {
    case "record_list":
      return draft.entityId ? { entityId: draft.entityId, limit: 10 } : null;
    case "calendar":
      return draft.entityId && draft.dateField
        ? { entityId: draft.entityId, dateField: draft.dateField }
        : null;
    case "kpi": {
      const label = draft.label.trim();
      if (draft.source === "meter") {
        if (!draft.meter) return null;
        return {
          source: "meter",
          meter: draft.meter,
          label: label || meterLabel(draft.meter) || "KPI",
        };
      }
      if (!draft.entityId) return null;
      return { source: "count", entityId: draft.entityId, label: label || "Records" };
    }
    case "chart":
      return draft.meter
        ? {
            meter: draft.meter,
            label: draft.label.trim() || `${meterLabel(draft.meter)} usage`,
          }
        : null;
    default:
      // An unknown/plugin type carries no schema the server checks (AC2).
      return {};
  }
}

/** Why "Add widget" is disabled, in the user's terms. */
function missingHint(type: string, draft: Draft, hasEntities: boolean): string | null {
  if (
    type === "record_list" ||
    type === "calendar" ||
    (type === "kpi" && draft.source === "count")
  ) {
    if (!hasEntities) {
      return "This widget reads an entity's records — create an entity first.";
    }
    if (!draft.entityId) return "Choose an entity for this widget.";
  }
  if (type === "calendar" && !draft.dateField) {
    return "This entity has no date field to plot — add one to its schema first.";
  }
  return null;
}

export default function DashboardComposerPage() {
  const params = useParams<{ dashboardId: string }>();
  const { me } = useMe();
  const [state, setState] = useState<State>({ status: "loading" });
  const [entities, setEntities] = useState<EntityOption[]>([]);
  const [addingType, setAddingType] = useState<string>(WIDGET_CATALOG[0].type);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  useEffect(() => {
    void fetchDashboard(params.dashboardId).then(setState);
    void fetchEntities().then(setEntities);
  }, [params.dashboardId]);

  const canUseChart = me ? me.tenant.tier !== "free" : false;

  const selectedEntity = entities.find((entity) => entity.id === draft.entityId);
  const dateFields = useMemo(
    () => selectedEntity?.fields.filter((field) => field.type === "date") ?? [],
    [selectedEntity],
  );

  // Picking an entity settles the date field too: one date field is the common
  // case, and a stale `dateField` from a previous entity would fail validation.
  useEffect(() => {
    setDraft((prev) => ({ ...prev, dateField: dateFields[0]?.key ?? "" }));
  }, [dateFields]);

  const pendingConfig = buildConfig(addingType, draft);
  const hint = missingHint(addingType, draft, entities.length > 0);

  async function persist(widgets: WidgetInstance[]) {
    if (state.status !== "ready") return;
    const previous = state.dashboard;
    const relaidWidgets = relaid(widgets);
    setSaveError(null);
    setState({ status: "ready", dashboard: { ...previous, widgets: relaidWidgets } });

    const result = await saveWidgets(params.dashboardId, relaidWidgets);
    if (result.ok) {
      setState({ status: "ready", dashboard: result.dashboard });
      return;
    }
    // Roll back — never leave the screen showing what the server refused.
    setState({ status: "ready", dashboard: previous });
    setSaveError(result.message);
  }

  function addWidget() {
    if (state.status !== "ready" || !pendingConfig) return;
    const widget: WidgetInstance = {
      id: newWidgetId(),
      type: addingType,
      config: pendingConfig,
      layout: layoutFor(state.dashboard.widgets.length),
    };
    void persist([...state.dashboard.widgets, widget]);
    setDraft((prev) => ({ ...prev, label: "" }));
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
  const needsEntity =
    addingType === "record_list" ||
    addingType === "calendar" ||
    (addingType === "kpi" && draft.source === "count");
  const needsMeter =
    addingType === "chart" || (addingType === "kpi" && draft.source === "meter");

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-semibold tracking-tight">{dashboard.name}</h1>

      <div className="mt-4 rounded-lg border bg-graft-green/[0.03] p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="widget-type" className="mb-1 block text-xs">
              Widget type
            </Label>
            <Select
              value={addingType}
              onValueChange={(value) => {
                setAddingType(value);
                setSaveError(null);
              }}
            >
              <SelectTrigger
                id="widget-type"
                aria-label="Widget type"
                size="sm"
                className="w-40"
              >
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

          {addingType === "kpi" ? (
            <div>
              <Label htmlFor="kpi-source" className="mb-1 block text-xs">
                Measures
              </Label>
              <Select
                value={draft.source}
                onValueChange={(value) =>
                  setDraft((prev) => ({ ...prev, source: value as Draft["source"] }))
                }
              >
                <SelectTrigger id="kpi-source" aria-label="Measures" size="sm" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="meter">Plan usage</SelectItem>
                  <SelectItem value="count">Records in an entity</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {needsEntity ? (
            <div>
              <Label htmlFor="widget-entity" className="mb-1 block text-xs">
                Entity
              </Label>
              <Select
                value={draft.entityId}
                onValueChange={(value) => setDraft((prev) => ({ ...prev, entityId: value }))}
                disabled={entities.length === 0}
              >
                <SelectTrigger
                  id="widget-entity"
                  aria-label="Entity"
                  size="sm"
                  className="w-44"
                >
                  <SelectValue placeholder={entities.length ? "Choose…" : "No entities yet"} />
                </SelectTrigger>
                <SelectContent>
                  {entities.map((entity) => (
                    <SelectItem key={entity.id} value={entity.id}>
                      {entity.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {addingType === "calendar" && dateFields.length > 0 ? (
            <div>
              <Label htmlFor="widget-date-field" className="mb-1 block text-xs">
                Date field
              </Label>
              <Select
                value={draft.dateField}
                onValueChange={(value) => setDraft((prev) => ({ ...prev, dateField: value }))}
              >
                <SelectTrigger
                  id="widget-date-field"
                  aria-label="Date field"
                  size="sm"
                  className="w-40"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {dateFields.map((field) => (
                    <SelectItem key={field.key} value={field.key}>
                      {field.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {needsMeter ? (
            <div>
              <Label htmlFor="widget-meter" className="mb-1 block text-xs">
                Metric
              </Label>
              <Select
                value={draft.meter}
                onValueChange={(value) => setDraft((prev) => ({ ...prev, meter: value }))}
              >
                <SelectTrigger id="widget-meter" aria-label="Metric" size="sm" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WIDGET_METERS.map((entry) => (
                    <SelectItem key={entry.meter} value={entry.meter}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {addingType === "kpi" || addingType === "chart" ? (
            <div>
              <Label htmlFor="widget-label" className="mb-1 block text-xs">
                Label <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="widget-label"
                value={draft.label}
                maxLength={120}
                placeholder="Auto"
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, label: event.target.value }))
                }
                className="h-8 w-40"
              />
            </div>
          ) : null}

          <Button type="button" size="sm" onClick={addWidget} disabled={!pendingConfig}>
            <PlusIcon /> Add widget
          </Button>
        </div>

        {hint ? <p className="mt-2 text-xs text-muted-foreground">{hint}</p> : null}

        {/* The Chart widget stores and renders fine on Free — it is its data
         * (`/api/v1/reports/usage`) that is Premium+, so this is a heads-up,
         * not a block, and it points at where to act on it. */}
        {addingType === "chart" && !canUseChart ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Charts need Premium to load their data.{" "}
            <Link
              href="/account"
              className="font-medium text-graft-green underline-offset-4 hover:underline dark:text-graft-green-light"
            >
              View plans
            </Link>
          </p>
        ) : null}

        {saveError ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {saveError}
          </p>
        ) : null}
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
