/**
 * Widget Registry — unit coverage (GRAFT-13 AC2): resolution for every known
 * type, and the unknown-type fallback that keeps a bad/future `type` from
 * crashing the dashboard.
 */
import { describe, expect, it } from "vitest";
import { CalendarWidget } from "@/components/widgets/calendar-widget";
import { ChartWidget } from "@/components/widgets/chart-widget";
import { KpiWidget } from "@/components/widgets/kpi-widget";
import { RecordListWidget } from "@/components/widgets/record-list-widget";
import { UnknownWidget } from "@/components/widgets/unknown-widget";
import { resolveWidget, WIDGET_CATALOG } from "./registry";

describe("resolveWidget", () => {
  it("resolves every known type to its component", () => {
    expect(resolveWidget("record_list")).toBe(RecordListWidget);
    expect(resolveWidget("kpi")).toBe(KpiWidget);
    expect(resolveWidget("calendar")).toBe(CalendarWidget);
    expect(resolveWidget("chart")).toBe(ChartWidget);
  });

  it("AC2 — falls back to UnknownWidget for a type this build has never heard of", () => {
    expect(resolveWidget("future_plugin_widget")).toBe(UnknownWidget);
    expect(resolveWidget("")).toBe(UnknownWidget);
  });

  it("the composer's catalog only ever offers known, resolvable types", () => {
    for (const entry of WIDGET_CATALOG) {
      expect(resolveWidget(entry.type)).not.toBe(UnknownWidget);
    }
  });
});
