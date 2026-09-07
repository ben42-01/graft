/**
 * The meters a KPI/Chart widget can be pointed at, with human labels.
 *
 * Declared here rather than imported from `src/server/services/meters.ts`
 * for the same reason `types.ts` mirrors `WidgetConfig`: that module reaches
 * for mongodb and can't cross into a `"use client"` tree. `meters.test.ts`
 * pins these keys against the server's `METERS` so the two can't drift.
 */
export const WIDGET_METERS = [
  { meter: "records", label: "Records" },
  { meter: "entities", label: "Custom entities" },
  { meter: "form_submissions", label: "Form submissions" },
  { meter: "active_forms", label: "Active forms" },
  { meter: "internal_forms", label: "Internal forms" },
  { meter: "dashboards", label: "Dashboards" },
  { meter: "plugins", label: "Plugins enabled" },
  { meter: "seats", label: "Seats" },
  { meter: "storage_mb", label: "Storage (MB)" },
] as const;

export type WidgetMeter = (typeof WIDGET_METERS)[number]["meter"];

export function meterLabel(meter: string | undefined): string | undefined {
  return WIDGET_METERS.find((entry) => entry.meter === meter)?.label;
}
