/**
 * The daily dispatch — component coverage (docs/BMS_EXTENSION.md §2.3).
 *
 * `buildDispatch` is the piece worth testing hardest: it is pure, it decides
 * what a business is told to do today, and every boundary in it ("starting" vs
 * "out now" vs "due back") is an off-by-one waiting to happen.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildDispatch, DailyDispatch } from "./daily-dispatch";
import type { TimelineAllocation } from "./resource-timeline";
import type { BoardOrder } from "./order-board";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();

const allocation = (over: Partial<TimelineAllocation> = {}): TimelineAllocation => ({
  id: Math.random().toString(36).slice(2),
  poolId: "pool-1",
  recordId: "record-1",
  resourceLabel: "24ft Pontoon Boat",
  startAt: at(1),
  endAt: at(3),
  blockedFrom: at(1),
  blockedUntil: at(3),
  quantity: 1,
  status: "confirmed",
  ...over,
});

const order = (over: Partial<BoardOrder> = {}): BoardOrder => ({
  id: Math.random().toString(36).slice(2),
  status: "confirmed",
  currency: "EUR",
  totalMinor: 60_000,
  balanceMinor: 0,
  customerLabel: "Jane Doe",
  lineSummary: "24ft Pontoon Boat — 4 hours",
  createdAt: NOW.toISOString(),
  ...over,
});

describe("buildDispatch", () => {
  it("puts a booking that has not started yet in 'starting'", () => {
    const dispatch = buildDispatch([allocation({ startAt: at(2), endAt: at(4) })], [], NOW);
    expect(dispatch.starting).toHaveLength(1);
    expect(dispatch.active).toHaveLength(0);
  });

  it("puts a booking that is underway in 'out now'", () => {
    const dispatch = buildDispatch([allocation({ startAt: at(-1), endAt: at(2) })], [], NOW);
    expect(dispatch.active).toHaveLength(1);
    expect(dispatch.starting).toHaveLength(0);
  });

  it("counts a booking due back later today as returning", () => {
    const dispatch = buildDispatch([allocation({ startAt: at(-1), endAt: at(3) })], [], NOW);
    expect(dispatch.returning).toHaveLength(1);
  });

  it("ignores a booking that already finished", () => {
    const dispatch = buildDispatch([allocation({ startAt: at(-4), endAt: at(-1) })], [], NOW);
    expect(dispatch.active).toHaveLength(0);
    expect(dispatch.starting).toHaveLength(0);
  });

  it("ignores released and cancelled allocations entirely", () => {
    const dispatch = buildDispatch(
      [
        allocation({ startAt: at(2), status: "released" }),
        allocation({ startAt: at(2), status: "cancelled" }),
      ],
      [],
      NOW,
    );
    expect(dispatch.starting).toHaveLength(0);
  });

  it("counts an unconfirmed hold — it is still occupying the resource", () => {
    const dispatch = buildDispatch(
      [allocation({ startAt: at(2), endAt: at(4), status: "held" })],
      [],
      NOW,
    );
    expect(dispatch.starting).toHaveLength(1);
  });

  it("excludes tomorrow's bookings from today's dispatch", () => {
    const dispatch = buildDispatch([allocation({ startAt: at(30), endAt: at(34) })], [], NOW);
    expect(dispatch.starting).toHaveLength(0);
    expect(dispatch.returning).toHaveLength(0);
  });

  it("sorts what is starting by time, so the list reads as a running order", () => {
    const dispatch = buildDispatch(
      [
        allocation({ resourceLabel: "Later", startAt: at(5), endAt: at(6) }),
        allocation({ resourceLabel: "Sooner", startAt: at(1), endAt: at(2) }),
      ],
      [],
      NOW,
    );
    expect(dispatch.starting.map((a) => a.resourceLabel)).toEqual(["Sooner", "Later"]);
  });
});

describe("buildDispatch — money owed", () => {
  it("lists orders with a balance, biggest first", () => {
    const dispatch = buildDispatch(
      [],
      [
        order({ customerLabel: "Small", balanceMinor: 1_000 }),
        order({ customerLabel: "Big", balanceMinor: 50_000 }),
      ],
      NOW,
    );
    expect(dispatch.owing.map((o) => o.customerLabel)).toEqual(["Big", "Small"]);
  });

  it("ignores fully paid orders", () => {
    const dispatch = buildDispatch([], [order({ balanceMinor: 0 })], NOW);
    expect(dispatch.owing).toHaveLength(0);
  });

  it("ignores drafts and cancellations — nobody has been asked for that money", () => {
    const dispatch = buildDispatch(
      [],
      [
        order({ status: "draft", balanceMinor: 10_000 }),
        order({ status: "cancelled", balanceMinor: 10_000 }),
      ],
      NOW,
    );
    expect(dispatch.owing).toHaveLength(0);
  });
});

describe("DailyDispatch", () => {
  it("states each panel's emptiness rather than rendering blank", () => {
    render(<DailyDispatch dispatch={buildDispatch([], [], NOW)} />);

    expect(screen.getByText("Nothing else starts today.")).toBeInTheDocument();
    expect(screen.getByText("Nothing is out at the moment.")).toBeInTheDocument();
    expect(screen.getByText("Everything is paid up.")).toBeInTheDocument();
  });

  it("names the resource and the time, not an id", () => {
    const dispatch = buildDispatch(
      [allocation({ resourceLabel: "Kayak #3", startAt: at(2), endAt: at(4) })],
      [],
      NOW,
    );
    render(<DailyDispatch dispatch={dispatch} />);

    expect(screen.getAllByText("Kayak #3").length).toBeGreaterThan(0);
  });

  it("flags an unconfirmed hold, which lapses if nobody acts", () => {
    const dispatch = buildDispatch(
      [allocation({ startAt: at(2), endAt: at(4), status: "held" })],
      [],
      NOW,
    );
    render(<DailyDispatch dispatch={dispatch} />);
    // Twice, legitimately: a hire that both starts and ends today is on the
    // "starting" list and the "due back" list, and both are things to act on.
    expect(screen.getAllByText("Unconfirmed hold")).toHaveLength(2);
  });

  it("shows what is owed as money, in the order's own currency", () => {
    const dispatch = buildDispatch([], [order({ balanceMinor: 42_000 })], NOW);
    render(<DailyDispatch dispatch={dispatch} />);
    expect(screen.getByText(/420\.00/)).toBeInTheDocument();
  });
});
