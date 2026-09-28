"use client";

/**
 * The admin console's charts — plain HTML/CSS, no charting dependency (same
 * call stats-widgets.tsx made: a dozen bars do not justify a library).
 *
 * Colours come from the `--chart-*` tokens in globals.css, validated for
 * colour-blind separation in both themes. Each chart has a legend when it has
 * two or more series, a per-column hover tooltip, and a visually hidden table
 * carrying the same numbers for screen readers.
 */
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { formatNumber } from "./admin-ui";

export type ColumnSeries = { key: string; label: string; color: string };

export type ColumnDatum = { label: string; tooltipLabel?: string } & Record<
  string,
  number | string | undefined
>;

function niceMax(value: number): number {
  if (value <= 4) return Math.max(1, value);
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * magnitude >= value) ?? 10;
  return step * magnitude;
}

export function Legend({
  items,
}: {
  items: { label: string; color: string; value?: ReactNode }[];
}) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span
            className="size-2.5 rounded-sm"
            style={{ background: item.color }}
            aria-hidden="true"
          />
          {item.label}
          {item.value !== undefined ? (
            <span className="font-medium text-foreground tabular-nums">{item.value}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Vertical columns over a dense time axis. With two or more series the
 * columns stack (first series at the baseline), separated by a 2px gap.
 */
export function ColumnChart({
  data,
  series,
  height = 160,
  caption,
  onSelect,
}: {
  data: ColumnDatum[];
  series: ColumnSeries[];
  height?: number;
  caption: string;
  onSelect?: (index: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  // A column is a button only when clicking it does something.
  const Column = onSelect ? "button" : "div";
  const totals = data.map((d) =>
    series.reduce(
      (sum, s) => sum + (typeof d[s.key] === "number" ? (d[s.key] as number) : 0),
      0,
    ),
  );
  const max = niceMax(Math.max(0, ...totals));
  const tickLabels = [0, Math.round(data.length / 2), data.length - 1].filter(
    (value, index, all) => value >= 0 && all.indexOf(value) === index,
  );

  return (
    <figure className="flex flex-col gap-2">
      {series.length > 1 ? (
        <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
      ) : null}
      <div className="flex gap-2">
        <div
          className="flex flex-col justify-between text-right text-[10px] text-muted-foreground tabular-nums"
          style={{ height }}
          aria-hidden="true"
        >
          <span>{formatNumber(max)}</span>
          <span>{formatNumber(max / 2)}</span>
          <span>0</span>
        </div>
        <div className="relative min-w-0 flex-1">
          {/* Recessive gridlines at 0, ½ and max. */}
          <div
            className="pointer-events-none absolute inset-0 flex flex-col justify-between"
            aria-hidden="true"
          >
            <span className="border-t border-dashed border-border" />
            <span className="border-t border-dashed border-border" />
            <span className="border-t border-border" />
          </div>
          <div
            className="relative flex items-end gap-[2px]"
            style={{ height }}
            onMouseLeave={() => setHover(null)}
          >
            {data.map((d, index) => {
              const total = totals[index] ?? 0;
              return (
                <Column
                  key={`${d.label}-${index}`}
                  {...(onSelect
                    ? {
                        type: "button" as const,
                        "aria-label": `${d.tooltipLabel ?? d.label}: ${formatNumber(total)}`,
                        onClick: () => onSelect(index),
                      }
                    : { "aria-hidden": true })}
                  onMouseEnter={() => setHover(index)}
                  onFocus={() => setHover(index)}
                  onBlur={() => setHover(null)}
                  className={cn(
                    "group relative flex h-full min-w-0 flex-1 flex-col justify-end outline-none",
                    onSelect ? "cursor-pointer" : "cursor-default",
                  )}
                >
                  <span
                    className={cn(
                      "absolute inset-x-0 top-0 bottom-0 rounded-sm transition-colors",
                      hover === index && "bg-muted/60",
                    )}
                    aria-hidden="true"
                  />
                  <span
                    className="relative flex flex-col-reverse gap-[2px]"
                    style={{ height: `${(total / max) * 100}%` }}
                  >
                    {series.map((s, si) => {
                      const value = typeof d[s.key] === "number" ? (d[s.key] as number) : 0;
                      if (value <= 0) return null;
                      const isTop = series
                        .slice(si + 1)
                        .every((next) => !((d[next.key] as number) > 0));
                      return (
                        <span
                          key={s.key}
                          className={cn("block w-full", isTop && "rounded-t-[4px]")}
                          style={{
                            flexGrow: value,
                            flexBasis: 0,
                            minHeight: 2,
                            background: s.color,
                          }}
                        />
                      );
                    })}
                  </span>
                </Column>
              );
            })}
          </div>
          {hover !== null && data[hover] ? (
            <div
              className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs whitespace-nowrap text-popover-foreground shadow-md"
              style={{ left: `${((hover + 0.5) / data.length) * 100}%` }}
              role="presentation"
            >
              <div className="font-medium">{data[hover].tooltipLabel ?? data[hover].label}</div>
              {series.map((s) => (
                <div key={s.key} className="flex items-center gap-1.5 text-muted-foreground">
                  <span className="size-2 rounded-sm" style={{ background: s.color }} />
                  {s.label}
                  <span className="ml-auto pl-3 font-medium text-foreground tabular-nums">
                    {formatNumber((data[hover][s.key] as number) ?? 0)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          <div
            className="relative mt-1 h-4 text-[10px] text-muted-foreground"
            aria-hidden="true"
          >
            {tickLabels.map((index) => (
              <span
                key={index}
                className={cn(
                  "absolute whitespace-nowrap",
                  index === 0
                    ? "left-0"
                    : index === data.length - 1
                      ? "right-0"
                      : "-translate-x-1/2",
                )}
                style={
                  index !== 0 && index !== data.length - 1
                    ? { left: `${((index + 0.5) / data.length) * 100}%` }
                    : undefined
                }
              >
                {data[index]?.label}
              </span>
            ))}
          </div>
        </div>
      </div>
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((d, index) => (
            <tr key={`${d.label}-${index}`}>
              <th scope="row">{d.tooltipLabel ?? d.label}</th>
              {series.map((s) => (
                <td key={s.key}>{(d[s.key] as number) ?? 0}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/**
 * A ranked list with an inline bar per row — breakdowns (by family, action,
 * tenant). Single series, so no legend; the value is always printed.
 */
export function BreakdownBars({
  rows,
  color = "var(--chart-ok)",
  empty = "Nothing in this range.",
  onSelect,
}: {
  rows: { key: string; label: ReactNode; value: number; secondary?: ReactNode }[];
  color?: string;
  empty?: string;
  onSelect?: (key: string) => void;
}) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => {
        const content = (
          <>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{row.label}</span>
              <span className="flex shrink-0 items-baseline gap-2">
                {row.secondary ? (
                  <span className="text-xs text-muted-foreground">{row.secondary}</span>
                ) : null}
                <span className="font-medium tabular-nums">{formatNumber(row.value)}</span>
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-muted">
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.max(2, (row.value / max) * 100)}%`, background: color }}
              />
            </div>
          </>
        );
        return (
          <li key={row.key}>
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(row.key)}
                className="flex w-full flex-col gap-1 rounded-md px-1 py-0.5 text-left hover:bg-muted/50"
              >
                {content}
              </button>
            ) : (
              <div className="flex flex-col gap-1 px-1 py-0.5">{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Parts of a whole — one bar, segments separated by 2px, legend with counts. */
export function SegmentBar({
  segments,
}: {
  segments: { label: string; value: number; color: string }[];
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full bg-muted">
        {segments.map((s) =>
          s.value > 0 ? (
            <div
              key={s.label}
              style={{ flexGrow: s.value, flexBasis: 0, background: s.color }}
              title={`${s.label}: ${formatNumber(s.value)}`}
            />
          ) : null,
        )}
      </div>
      <Legend
        items={segments.map((s) => ({
          label: s.label,
          color: s.color,
          value: `${formatNumber(s.value)}${total > 0 ? ` · ${Math.round((s.value / total) * 100)}%` : ""}`,
        }))}
      />
    </div>
  );
}

const shortDay = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const longDay = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const hourFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayHourFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** Axis + tooltip labels for a `YYYY-MM-DD` day bucket (UTC). */
export function dayLabels(day: string): { label: string; tooltipLabel: string } {
  const date = new Date(`${day}T00:00:00Z`);
  return { label: shortDay.format(date), tooltipLabel: longDay.format(date) };
}

/** Axis + tooltip labels for an ISO bucket start, hourly or daily. */
export function bucketLabels(
  at: string,
  bucket: "hour" | "day",
): { label: string; tooltipLabel: string } {
  const date = new Date(at);
  return bucket === "hour"
    ? { label: hourFmt.format(date), tooltipLabel: dayHourFmt.format(date) }
    : { label: shortDay.format(date), tooltipLabel: longDay.format(date) };
}
