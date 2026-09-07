"use client";

/**
 * The master schedule of docs/BMS_EXTENSION.md §2.3 — one row per resource,
 * time running left to right, allocations drawn as bars.
 *
 * Four things matter enough to call out:
 *
 *   - **Buffer blocks are drawn, not hidden.** An allocation occupies
 *     `blockedFrom`–`blockedUntil`, and the turnaround either side is rendered
 *     as a hatched extension of the bar. A scheduler that shows only the booked
 *     hours makes the gaps look bookable when they are not, which is the exact
 *     question this view exists to answer.
 *   - **Bars are positioned in percentages of the visible window**, so the
 *     whole thing is a CSS layout that reflows rather than a canvas that has to
 *     be redrawn. It stays legible when the browser is zoomed and when the
 *     container is narrow.
 *   - **Every bar is a real button with a text label.** A timeline made of
 *     coloured `div`s is invisible to anyone not looking at it, so each bar
 *     carries an accessible name naming the resource and both times.
 *   - **Colour never carries the only meaning.** A held allocation is
 *     distinguished from a confirmed one by a dashed outline and the word
 *     "Hold" in its label, not by hue alone.
 */
import { useMemo } from "react";
import { cn } from "@/lib/utils";

export type TimelineAllocation = {
  id: string;
  poolId: string;
  recordId: string;
  resourceLabel: string;
  startAt: string;
  endAt: string;
  blockedFrom: string;
  blockedUntil: string;
  quantity: number;
  status: "held" | "confirmed" | "released" | "cancelled";
};

const HOUR = 3_600_000;

const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const dayLabel = (date: Date) =>
  date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

export function ResourceTimeline({
  allocations,
  from,
  to,
  onSelect,
}: {
  allocations: TimelineAllocation[];
  from: Date;
  to: Date;
  onSelect?: (allocation: TimelineAllocation) => void;
}) {
  const spanMs = Math.max(HOUR, to.getTime() - from.getTime());

  /** One row per resource, so a boat's whole day reads as a single line. */
  const rows = useMemo(() => {
    const byResource = new Map<string, { label: string; items: TimelineAllocation[] }>();
    for (const allocation of allocations) {
      // Released and cancelled rows consume nothing and would only clutter a
      // view whose purpose is "what is actually occupied".
      if (allocation.status === "released" || allocation.status === "cancelled") continue;
      const existing = byResource.get(allocation.poolId);
      if (existing) existing.items.push(allocation);
      else
        byResource.set(allocation.poolId, {
          label: allocation.resourceLabel,
          items: [allocation],
        });
    }
    return [...byResource.entries()]
      .map(([poolId, row]) => ({ poolId, ...row }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [allocations]);

  /** Hour marks, thinned so a week-long window does not draw 168 of them. */
  const ticks = useMemo(() => {
    const hours = spanMs / HOUR;
    const step = hours <= 12 ? 1 : hours <= 48 ? 6 : 24;
    const out: { at: Date; left: number }[] = [];
    const start = new Date(from);
    start.setMinutes(0, 0, 0);
    for (let t = start.getTime(); t <= to.getTime(); t += step * HOUR) {
      const left = ((t - from.getTime()) / spanMs) * 100;
      if (left >= 0 && left <= 100) out.push({ at: new Date(t), left });
    }
    return { marks: out, step };
  }, [from, to, spanMs]);

  const percent = (iso: string) => ((new Date(iso).getTime() - from.getTime()) / spanMs) * 100;

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
        Nothing is booked in this window.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[48rem]">
        <p className="mb-2 text-xs text-muted-foreground">
          {dayLabel(from)} – {dayLabel(to)}
        </p>

        {/* The scale. `aria-hidden` because the bars below name their own
         * times; a screen reader reading out 24 tick marks helps nobody. */}
        <div
          aria-hidden
          className="relative mb-1 h-5 border-b text-[10px] text-muted-foreground"
        >
          {ticks.marks.map(({ at, left }) => (
            <span
              key={at.toISOString()}
              className="absolute -translate-x-1/2 whitespace-nowrap"
              style={{ left: `${left}%` }}
            >
              {ticks.step >= 24
                ? at.toLocaleDateString(undefined, { day: "numeric", month: "short" })
                : at.toLocaleTimeString(undefined, { hour: "2-digit" })}
            </span>
          ))}
        </div>

        <ul className="flex flex-col gap-1.5">
          {rows.map((row) => (
            <li key={row.poolId} className="flex items-stretch gap-3">
              <span className="w-40 shrink-0 self-center truncate text-sm font-medium">
                {row.label}
              </span>
              <div className="relative h-10 flex-1 rounded-md border bg-muted/40">
                {/* Gridlines, matching the scale above. */}
                {ticks.marks.map(({ at, left }) => (
                  <span
                    key={at.toISOString()}
                    aria-hidden
                    className="absolute inset-y-0 border-l border-border/60"
                    style={{ left: `${left}%` }}
                  />
                ))}

                {row.items.map((allocation) => {
                  const blockedLeft = Math.max(0, percent(allocation.blockedFrom));
                  const blockedRight = Math.min(100, percent(allocation.blockedUntil));
                  const bookedLeft = Math.max(0, percent(allocation.startAt));
                  const bookedRight = Math.min(100, percent(allocation.endAt));
                  const held = allocation.status === "held";

                  return (
                    <button
                      key={allocation.id}
                      type="button"
                      onClick={() => onSelect?.(allocation)}
                      aria-label={[
                        row.label,
                        held ? "hold" : "booking",
                        `${timeLabel(allocation.startAt)} to ${timeLabel(allocation.endAt)}`,
                        allocation.quantity > 1 ? `quantity ${allocation.quantity}` : null,
                        allocation.blockedUntil !== allocation.endAt
                          ? `turnaround until ${timeLabel(allocation.blockedUntil)}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                      className="absolute inset-y-1 rounded-sm focus-visible:ring-2 focus-visible:ring-graft-green focus-visible:ring-offset-1 focus-visible:outline-none"
                      style={{
                        left: `${blockedLeft}%`,
                        width: `${Math.max(0.5, blockedRight - blockedLeft)}%`,
                      }}
                    >
                      {/* The buffer: the full blocked span, hatched. */}
                      <span
                        aria-hidden
                        className="absolute inset-0 rounded-sm bg-[repeating-linear-gradient(45deg,var(--color-graft-green)_0_2px,transparent_2px_6px)] opacity-30"
                      />
                      {/* The booking itself, inset within it. */}
                      <span
                        aria-hidden
                        className={cn(
                          "absolute inset-y-0 flex items-center overflow-hidden rounded-sm px-1.5 text-[10px] font-medium whitespace-nowrap text-white",
                          held
                            ? "border border-dashed border-graft-green bg-graft-green/70"
                            : "bg-graft-green",
                        )}
                        style={{
                          left: `${((bookedLeft - blockedLeft) / Math.max(0.5, blockedRight - blockedLeft)) * 100}%`,
                          width: `${((bookedRight - bookedLeft) / Math.max(0.5, blockedRight - blockedLeft)) * 100}%`,
                        }}
                      >
                        {held ? "Hold" : timeLabel(allocation.startAt)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>

        <p className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="size-3 rounded-sm bg-graft-green" /> Booked
          </span>
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-3 rounded-sm border border-dashed border-graft-green bg-graft-green/70"
            />{" "}
            Hold (expires unless confirmed)
          </span>
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-3 rounded-sm bg-[repeating-linear-gradient(45deg,var(--color-graft-green)_0_2px,transparent_2px_6px)] opacity-40"
            />{" "}
            Turnaround — not bookable
          </span>
        </p>
      </div>
    </div>
  );
}
