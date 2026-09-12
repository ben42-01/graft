/**
 * The widget size contract — the thing that stops a dashboard going ragged
 * as widget types are added.
 *
 * The regression these pin: every widget used to be created `{ w: 1, h: 1 }`
 * and packed to 2 columns in the composer, while the API validated layouts
 * against 4 (`layoutSchema`, src/server/services/dashboards.ts). So stored
 * positions never meant what the screen showed, and a one-line KPI shared a
 * row with a ten-row table sized to the table.
 */
import { describe, expect, it } from "vitest";
import {
  GRID_COLUMNS,
  MAX_ROW_SPAN,
  DEFAULT_WIDGET_SIZE,
  packLayouts,
  sizeFor,
  spanClasses,
  WIDGET_SIZES,
} from "./sizes";
import { WIDGET_CATALOG } from "./registry";

describe("sizeFor", () => {
  it("gives every type in the composer's catalog a declared footprint", () => {
    for (const entry of WIDGET_CATALOG) {
      expect(WIDGET_SIZES[entry.type], `${entry.type} has no declared size`).toBeDefined();
    }
  });

  it("falls back to the default footprint for an unknown/plugin type", () => {
    expect(sizeFor("future_plugin_widget")).toEqual(DEFAULT_WIDGET_SIZE);
  });

  it("never returns a footprint the server's layout schema would reject", () => {
    for (const type of [...Object.keys(WIDGET_SIZES), "unknown"]) {
      const { w, h } = sizeFor(type);
      expect(w).toBeGreaterThanOrEqual(1);
      expect(w).toBeLessThanOrEqual(GRID_COLUMNS);
      expect(h).toBeGreaterThanOrEqual(1);
      expect(h).toBeLessThanOrEqual(MAX_ROW_SPAN);
    }
  });

  it("sizes a KPI smaller than a Record List — the raggedness this fixes", () => {
    const kpi = sizeFor("kpi");
    const list = sizeFor("record_list");
    expect(kpi.w * kpi.h).toBeLessThan(list.w * list.h);
  });
});

describe("packLayouts", () => {
  it("packs four KPIs into a single row of the 4-column grid", () => {
    expect(packLayouts(["kpi", "kpi", "kpi", "kpi"])).toEqual([
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 1, y: 0, w: 1, h: 1 },
      { x: 2, y: 0, w: 1, h: 1 },
      { x: 3, y: 0, w: 1, h: 1 },
    ]);
  });

  it("wraps a widget that does not fit the remaining columns", () => {
    // 1 + 2 leaves one free column, which a second 2-wide widget cannot use.
    const [kpi, chart, list] = packLayouts(["kpi", "chart", "record_list"]);
    expect(kpi).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(chart).toEqual({ x: 1, y: 0, w: 2, h: 1 });
    expect(list!.y).toBe(1);
    expect(list!.x).toBe(0);
  });

  it("fills the gap beside a tall widget instead of leaving it blank", () => {
    // The record list occupies rows 0-1 in columns 0-1; the KPIs backfill the
    // right-hand half of *both* rows rather than starting a third.
    const [list, a, b, c, d] = packLayouts(["record_list", "kpi", "kpi", "kpi", "kpi"]);
    expect(list).toEqual({ x: 0, y: 0, w: 2, h: 2 });
    expect([a, b, c, d]).toEqual([
      { x: 2, y: 0, w: 1, h: 1 },
      { x: 3, y: 0, w: 1, h: 1 },
      { x: 2, y: 1, w: 1, h: 1 },
      { x: 3, y: 1, w: 1, h: 1 },
    ]);
  });

  it("never overlaps two widgets and never runs off the right edge", () => {
    const types = ["record_list", "kpi", "chart", "calendar", "kpi", "unknown", "kpi"];
    const seen = new Set<string>();

    for (const { x, y, w, h } of packLayouts(types)) {
      expect(x + w).toBeLessThanOrEqual(GRID_COLUMNS);
      for (let dy = 0; dy < h; dy += 1) {
        for (let dx = 0; dx < w; dx += 1) {
          const cell = `${x + dx}:${y + dy}`;
          expect(seen.has(cell), `overlap at ${cell}`).toBe(false);
          seen.add(cell);
        }
      }
    }
  });

  it("is pure — the same order always yields the same grid", () => {
    const types = ["kpi", "record_list", "chart"];
    expect(packLayouts(types)).toEqual(packLayouts(types));
  });

  it("handles an empty dashboard", () => {
    expect(packLayouts([])).toEqual([]);
  });
});

describe("spanClasses", () => {
  it("emits literal Tailwind utilities, not interpolated ones", () => {
    // A class built as `col-span-${w}` is invisible to Tailwind's scanner and
    // ships as nothing — which is why these are looked up from a table.
    expect(spanClasses({ w: 2, h: 2 })).toBe("sm:col-span-2 lg:col-span-2 row-span-2");
    expect(spanClasses({ w: 1, h: 1 })).toBe("sm:col-span-1 lg:col-span-1 row-span-1");
  });

  it("clamps a 4-wide widget to the 2 columns that exist at the sm breakpoint", () => {
    expect(spanClasses({ w: 4, h: 1 })).toContain("sm:col-span-2");
    expect(spanClasses({ w: 4, h: 1 })).toContain("lg:col-span-4");
  });

  it("clamps out-of-range spans rather than emitting an undefined class", () => {
    expect(spanClasses({ w: 99, h: 99 })).not.toContain("undefined");
    expect(spanClasses({ w: 0, h: 0 })).not.toContain("undefined");
  });
});

describe("the server is the authority on layout", () => {
  it("every packed layout this module produces passes the API's own schema", async () => {
    // The whole point of GRID_COLUMNS being 4 here: the composer used to pack
    // to 2 and post layouts the server validated against 4. Asserting against
    // `widgetSchema` itself means a change to either side breaks this test
    // rather than quietly producing dashboards that don't match their data.
    const { widgetSchema } = await import("@/server/services/dashboards");

    const types = ["kpi", "chart", "record_list", "calendar", "kpi", "kpi"];
    const layouts = packLayouts(types);

    for (const layout of layouts) {
      const result = widgetSchema.safeParse({
        id: "w1",
        type: "future_plugin_widget", // config-free, so only `layout` is under test
        config: {},
        layout,
      });
      expect(result.success, JSON.stringify(layout)).toBe(true);
    }
  });
});
