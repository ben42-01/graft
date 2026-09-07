/**
 * The master schedule — component coverage (docs/BMS_EXTENSION.md §2.3).
 *
 * A timeline made of coloured rectangles is invisible to anyone not looking at
 * it, so most of what is asserted here is the *text*: that every bar names its
 * resource, its times and its turnaround, and that a hold is distinguishable
 * from a booking by more than a shade of green.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ResourceTimeline, type TimelineAllocation } from "./resource-timeline";

const FROM = new Date("2026-06-15T00:00:00.000Z");
const TO = new Date("2026-06-16T00:00:00.000Z");

const iso = (hours: number) => new Date(FROM.getTime() + hours * 3_600_000).toISOString();

const allocation = (over: Partial<TimelineAllocation> = {}): TimelineAllocation => ({
  id: "alloc-1",
  poolId: "pool-1",
  recordId: "record-1",
  resourceLabel: "24ft Pontoon Boat",
  startAt: iso(10),
  endAt: iso(14),
  blockedFrom: iso(10),
  blockedUntil: iso(14),
  quantity: 1,
  status: "confirmed",
  ...over,
});

describe("ResourceTimeline", () => {
  it("says so when nothing is booked, rather than drawing an empty grid", () => {
    render(<ResourceTimeline allocations={[]} from={FROM} to={TO} />);
    expect(screen.getByText("Nothing is booked in this window.")).toBeInTheDocument();
  });

  it("gives every bar an accessible name with the resource and both times", () => {
    render(<ResourceTimeline allocations={[allocation()]} from={FROM} to={TO} />);

    const bar = screen.getByRole("button", { name: /24ft Pontoon Boat/ });
    expect(bar).toHaveAccessibleName(/booking/);
    expect(bar).toHaveAccessibleName(/to/);
  });

  it("distinguishes a hold in words, not only in colour", () => {
    render(
      <ResourceTimeline allocations={[allocation({ status: "held" })]} from={FROM} to={TO} />,
    );
    expect(screen.getByRole("button", { name: /hold/ })).toBeInTheDocument();
  });

  it("announces the turnaround when one applies", () => {
    render(
      <ResourceTimeline
        allocations={[allocation({ blockedFrom: iso(9.5), blockedUntil: iso(14.5) })]}
        from={FROM}
        to={TO}
      />,
    );
    expect(screen.getByRole("button", { name: /turnaround until/ })).toBeInTheDocument();
  });

  it("says nothing about a turnaround when there is none", () => {
    render(<ResourceTimeline allocations={[allocation()]} from={FROM} to={TO} />);
    expect(screen.queryByRole("button", { name: /turnaround/ })).not.toBeInTheDocument();
  });

  it("names a pooled quantity, which a single bar cannot show visually", () => {
    render(
      <ResourceTimeline allocations={[allocation({ quantity: 4 })]} from={FROM} to={TO} />,
    );
    expect(screen.getByRole("button", { name: /quantity 4/ })).toBeInTheDocument();
  });

  it("gives each resource its own row, sorted by name", () => {
    render(
      <ResourceTimeline
        allocations={[
          allocation({ id: "b", poolId: "p2", resourceLabel: "Zodiac" }),
          allocation({ id: "a", poolId: "p1", resourceLabel: "Aluminium Skiff" }),
        ]}
        from={FROM}
        to={TO}
      />,
    );

    const labels = screen.getAllByRole("listitem").map((row) => row.textContent);
    expect(labels[0]).toContain("Aluminium Skiff");
    expect(labels[1]).toContain("Zodiac");
  });

  it("leaves released and cancelled allocations off the schedule entirely", () => {
    render(
      <ResourceTimeline
        allocations={[
          allocation({ id: "r", status: "released" }),
          allocation({ id: "c", poolId: "p2", status: "cancelled" }),
        ]}
        from={FROM}
        to={TO}
      />,
    );
    expect(screen.getByText("Nothing is booked in this window.")).toBeInTheDocument();
  });

  it("explains its own colours, since colour is never the only signal", () => {
    render(<ResourceTimeline allocations={[allocation()]} from={FROM} to={TO} />);
    expect(screen.getByText("Booked")).toBeInTheDocument();
    expect(screen.getByText(/Turnaround — not bookable/)).toBeInTheDocument();
  });
});
