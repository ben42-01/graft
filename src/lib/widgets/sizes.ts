/**
 * The widget size contract — how much of the grid a widget type asks for, and
 * how a list of widgets is packed into that grid.
 *
 * This exists because the composer used to give *every* widget
 * `{ x: index % 2, y: …, w: 1, h: 1 }` and render it into a `grid-cols-2`
 * with auto row heights. A KPI (one number, ~80px tall) and a Record List
 * (ten table rows, ~400px) therefore shared a row, and the row grew to the
 * taller one — so half the dashboard was whitespace, and each new widget type
 * added another way for the grid to go ragged. A type now declares its
 * footprint once, here, and both surfaces that render widgets (the composer
 * and the default Overview) lay out from the same numbers.
 *
 * `GRID_COLUMNS` is 4 to match the server's own `layoutSchema`
 * (src/server/services/dashboards.ts) — the composer was packing to 2 while
 * the API validated against 4, so a stored layout never meant quite what the
 * screen showed. A unit test pins the two together.
 */

export const GRID_COLUMNS = 4;

/** Rows are a fixed unit so `h` means the same thing on every dashboard. */
export const MAX_ROW_SPAN = 4;

export type WidgetSize = { w: number; h: number };

/**
 * A footprint per known type. Sized by what the widget *is*, not by what any
 * one tenant's data happens to make it: a KPI is always one number, a Record
 * List is always a table that wants room for rows.
 */
export const WIDGET_SIZES: Record<string, WidgetSize> = {
  kpi: { w: 1, h: 1 },
  chart: { w: 2, h: 1 },
  record_list: { w: 2, h: 2 },
  calendar: { w: 2, h: 2 },
};

/** An unknown (plugin-contributed, or newer-than-this-build) type. Half-width
 * and short: big enough to say what it is, small enough not to dominate a
 * dashboard with something this build cannot render. */
export const DEFAULT_WIDGET_SIZE: WidgetSize = { w: 2, h: 1 };

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

export function sizeFor(type: string): WidgetSize {
  const size = WIDGET_SIZES[type] ?? DEFAULT_WIDGET_SIZE;
  return { w: clamp(size.w, 1, GRID_COLUMNS), h: clamp(size.h, 1, MAX_ROW_SPAN) };
}

export type PackedLayout = { x: number; y: number; w: number; h: number };

/**
 * First-fit packing, scanning top-to-bottom then left-to-right: each widget
 * takes the first free block of its own size. Array order is still the only
 * thing a drag changes — position is *derived* from order and footprint, so
 * there is no second source of truth to keep in sync, and a reload replays
 * the same arrangement from the same array.
 */
export function packLayouts(types: readonly string[]): PackedLayout[] {
  const occupied = new Set<string>();
  const taken = (x: number, y: number) => occupied.has(`${x}:${y}`);

  const fits = (x: number, y: number, w: number, h: number) => {
    if (x + w > GRID_COLUMNS) return false;
    for (let dy = 0; dy < h; dy += 1) {
      for (let dx = 0; dx < w; dx += 1) if (taken(x + dx, y + dy)) return false;
    }
    return true;
  };

  return types.map((type) => {
    const { w, h } = sizeFor(type);
    for (let y = 0; ; y += 1) {
      for (let x = 0; x <= GRID_COLUMNS - w; x += 1) {
        if (!fits(x, y, w, h)) continue;
        for (let dy = 0; dy < h; dy += 1) {
          for (let dx = 0; dx < w; dx += 1) occupied.add(`${x + dx}:${y + dy}`);
        }
        return { x, y, w, h };
      }
      // `y` always terminates: a row is only skipped when something occupies
      // it, and each widget occupies finitely many rows.
    }
  });
}

/**
 * Tailwind span utilities, looked up rather than interpolated — a class built
 * as `col-span-${w}` is invisible to Tailwind's scanner and ships as nothing.
 *
 * Spans only apply from `sm` up. The base layout is a single column where
 * every widget is full width, which is the only arrangement that reads on a
 * phone; at `sm` the grid is 2 columns (a 4-wide widget is clamped to 2), and
 * at `lg` it is the full 4 the server validates against.
 */
const COL_SPAN: Record<number, string> = {
  1: "sm:col-span-1 lg:col-span-1",
  2: "sm:col-span-2 lg:col-span-2",
  3: "sm:col-span-2 lg:col-span-3",
  4: "sm:col-span-2 lg:col-span-4",
};

const ROW_SPAN: Record<number, string> = {
  1: "row-span-1",
  2: "row-span-2",
  3: "row-span-3",
  4: "row-span-4",
};

export function spanClasses({ w, h }: WidgetSize): string {
  return `${COL_SPAN[clamp(w, 1, GRID_COLUMNS)]} ${ROW_SPAN[clamp(h, 1, MAX_ROW_SPAN)]}`;
}

/** The grid a packed widget list is rendered into. One row unit is 10rem; a
 * `h: 2` widget gets two of them plus the gap between, which is what makes a
 * table card twice a KPI card rather than "whatever its contents came to". */
export const WIDGET_GRID_CLASS =
  "grid grid-cols-1 gap-4 auto-rows-[10rem] sm:grid-cols-2 lg:grid-cols-4";
