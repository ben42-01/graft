"use client";

/**
 * The Widget Registry (GRAFT-13, docs/Graft.md §4.3) — maps a stored widget's
 * `type` string to the component that renders it. `resolveWidget` never
 * throws: an unrecognised type resolves to `UnknownWidget` (AC2), which is
 * what makes the registry safe to grow later (GRAFT-14's plugin-contributed
 * widgets extend `REGISTRY` without this contract changing).
 */
import type { ComponentType } from "react";
import { CalendarWidget } from "@/components/widgets/calendar-widget";
import { ChartWidget } from "@/components/widgets/chart-widget";
import { KpiWidget } from "@/components/widgets/kpi-widget";
import { RecordListWidget } from "@/components/widgets/record-list-widget";
import { UnknownWidget } from "@/components/widgets/unknown-widget";
import type { WidgetInstance } from "./types";

export type WidgetProps = { widget: WidgetInstance; canUseChart: boolean };

/** The MVP catalog the composer's "Add widget" picker offers (docs/Graft.md
 * §4.3). Must stay in sync with KNOWN_WIDGET_TYPES in
 * src/server/services/dashboards.ts — a unit test pins that. */
export const WIDGET_CATALOG = [
  { type: "record_list", label: "Record List" },
  { type: "kpi", label: "KPI" },
  { type: "calendar", label: "Calendar" },
  { type: "chart", label: "Chart" },
] as const;

const REGISTRY: Record<string, ComponentType<WidgetProps>> = {
  record_list: RecordListWidget,
  kpi: KpiWidget,
  calendar: CalendarWidget,
  chart: ChartWidget,
};

export function resolveWidget(type: string): ComponentType<WidgetProps> {
  return REGISTRY[type] ?? UnknownWidget;
}
