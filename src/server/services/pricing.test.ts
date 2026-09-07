/**
 * Line-item pricing — unit coverage (docs/BMS_EXTENSION.md §2.2).
 *
 * This is the money. Every number an invoice shows comes out of these
 * functions, so the rounding rules, the direction each one rounds in, and the
 * integer-minor-units discipline are pinned individually rather than being
 * implied by a couple of end-to-end totals.
 */
import { describe, expect, it } from "vitest";
import {
  amountFor,
  balanceMinor,
  billableUnits,
  currencySchema,
  depositFor,
  formatMoney,
  rateFromRecord,
  resourceLineItem,
  toLineItem,
  toMajor,
  toMinor,
  totalsFor,
  type LineItem,
} from "./pricing";

const at = (iso: string) => new Date(iso);

describe("toMinor / toMajor", () => {
  it("converts authored major units to stored minor units", () => {
    expect(toMinor(150)).toBe(15_000);
    expect(toMinor(0)).toBe(0);
    expect(toMinor(0.01)).toBe(1);
    expect(toMinor(99.99)).toBe(9_999);
  });

  it("rounds once, at the boundary, rather than carrying a float onward", () => {
    // 12.345 is not a price anyone means to charge; it is accepted and
    // resolved here so nothing downstream ever sees a fraction of a cent.
    expect(toMinor(12.345)).toBe(1_235);
    expect(Number.isInteger(toMinor(0.1 + 0.2))).toBe(true);
  });

  it("survives the classic float trap", () => {
    // 0.1 + 0.2 === 0.30000000000000004. Three of those must still be 90c.
    const line = amountFor(3, toMinor(0.1 + 0.2));
    expect(line).toBe(90);
  });

  it("round-trips back to major for display", () => {
    expect(toMajor(15_000)).toBe(150);
  });

  it("refuses a non-finite price rather than storing NaN", () => {
    expect(() => toMinor(Number.NaN)).toThrow();
    expect(() => toMinor(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("currencySchema", () => {
  it("accepts and normalises an ISO 4217 code", () => {
    expect(currencySchema.parse("eur")).toBe("EUR");
    expect(currencySchema.parse(" usd ")).toBe("USD");
  });

  it("refuses anything that is not three letters", () => {
    expect(currencySchema.safeParse("EURO").success).toBe(false);
    expect(currencySchema.safeParse("E1R").success).toBe(false);
  });
});

describe("billableUnits", () => {
  it("bills whole hours, rounded up", () => {
    expect(
      billableUnits(at("2026-06-15T10:00:00Z"), at("2026-06-15T14:00:00Z"), "hourly"),
    ).toBe(4);
    // Four hours and one minute is five billable hours — rounding down would
    // give away 59 minutes of a boat.
    expect(
      billableUnits(at("2026-06-15T10:00:00Z"), at("2026-06-15T14:01:00Z"), "hourly"),
    ).toBe(5);
  });

  it("bills whole days, rounded up", () => {
    expect(billableUnits(at("2026-06-15T10:00:00Z"), at("2026-06-16T10:00:00Z"), "daily")).toBe(
      1,
    );
    expect(billableUnits(at("2026-06-15T10:00:00Z"), at("2026-06-16T10:01:00Z"), "daily")).toBe(
      2,
    );
  });

  it("is always one unit for a flat rate, whatever the duration", () => {
    expect(billableUnits(at("2026-06-15T10:00:00Z"), at("2026-06-30T10:00:00Z"), "flat")).toBe(
      1,
    );
  });

  it("charges one unit for a zero-length booking — the resource still left the market", () => {
    const t = at("2026-06-15T10:00:00Z");
    expect(billableUnits(t, t, "hourly")).toBe(1);
  });
});

describe("rateFromRecord", () => {
  it("reads a numeric rate", () => {
    expect(rateFromRecord({ hourly_rate: 150 }, "hourly")).toBe(150);
    expect(rateFromRecord({ daily_rate: 900 }, "daily")).toBe(900);
  });

  it("tolerates the string a form control produces", () => {
    expect(rateFromRecord({ hourly_rate: "150.50" }, "hourly")).toBe(150.5);
  });

  it("returns null rather than guessing when there is no usable rate", () => {
    expect(rateFromRecord({}, "hourly")).toBeNull();
    expect(rateFromRecord({ hourly_rate: "" }, "hourly")).toBeNull();
    expect(rateFromRecord({ hourly_rate: "free" }, "hourly")).toBeNull();
    expect(rateFromRecord({ hourly_rate: null }, "hourly")).toBeNull();
  });
});

describe("resourceLineItem", () => {
  const boat = { name: "24ft Pontoon Boat", data: { hourly_rate: 150 } };

  it("multiplies the base rate by the duration — §3.2's worked example", () => {
    const line = resourceLineItem({
      ...boat,
      basis: "hourly",
      startAt: at("2026-06-15T10:00:00Z"),
      endAt: at("2026-06-15T14:00:00Z"),
    });

    // 4 hours at €150 = €600.00
    expect(line.unitAmountMinor).toBe(60_000);
    expect(line.quantity).toBe(1);
    expect(line.amountMinor).toBe(60_000);
    expect(line.description).toBe("24ft Pontoon Boat — 4 hours");
  });

  it("keeps the duration in the unit price so quantity means 'how many'", () => {
    // Four boats for one hour must not look identical to one boat for four.
    const fourBoats = resourceLineItem({
      ...boat,
      basis: "hourly",
      startAt: at("2026-06-15T10:00:00Z"),
      endAt: at("2026-06-15T11:00:00Z"),
      quantity: 4,
    });
    expect(fourBoats.unitAmountMinor).toBe(15_000);
    expect(fourBoats.amountMinor).toBe(60_000);
    expect(fourBoats.description).toBe("24ft Pontoon Boat — 1 hour");
  });

  it("zero-rates a resource nobody priced rather than refusing the booking", () => {
    const line = resourceLineItem({
      name: "Unpriced thing",
      data: {},
      basis: "hourly",
      startAt: at("2026-06-15T10:00:00Z"),
      endAt: at("2026-06-15T12:00:00Z"),
    });
    expect(line.amountMinor).toBe(0);
  });

  it("carries the ids that say where the line came from", () => {
    const line = resourceLineItem({
      ...boat,
      basis: "flat",
      startAt: at("2026-06-15T10:00:00Z"),
      endAt: at("2026-06-15T12:00:00Z"),
      poolId: "000000000000000000000041",
      allocationId: "000000000000000000000061",
      recordId: "000000000000000000000051",
    });
    expect(line.poolId).toBe("000000000000000000000041");
    expect(line.allocationId).toBe("000000000000000000000061");
  });

  it("singularises a one-unit description", () => {
    const line = resourceLineItem({
      ...boat,
      basis: "daily",
      startAt: at("2026-06-15T10:00:00Z"),
      endAt: at("2026-06-16T10:00:00Z"),
    });
    expect(line.description).toBe("24ft Pontoon Boat — 1 day");
  });
});

describe("toLineItem", () => {
  it("computes the amount rather than trusting one", () => {
    const line = toLineItem({
      kind: "addon",
      description: "Life jackets",
      quantity: 4,
      unitAmountMinor: 500,
    });
    expect(line.amountMinor).toBe(2_000);
  });

  it("refuses a negative amount on a non-discount line", () => {
    expect(() =>
      toLineItem({
        kind: "addon",
        description: "Suspicious",
        quantity: 1,
        unitAmountMinor: -500,
      }),
    ).toThrow();
  });

  it("refuses a positive discount", () => {
    expect(() =>
      toLineItem({
        kind: "discount",
        description: "Loyalty",
        quantity: 1,
        unitAmountMinor: 500,
      }),
    ).toThrow();
  });
});

describe("totalsFor", () => {
  const items: LineItem[] = [
    toLineItem({ kind: "resource", description: "Boat", quantity: 1, unitAmountMinor: 60_000 }),
    toLineItem({ kind: "addon", description: "Cooler", quantity: 2, unitAmountMinor: 1_000 }),
    toLineItem({ kind: "fee", description: "Cleaning", quantity: 1, unitAmountMinor: 2_500 }),
    toLineItem({
      kind: "discount",
      description: "Repeat",
      quantity: 1,
      unitAmountMinor: -5_000,
    }),
  ];

  it("separates the discount so an invoice can show it on its own row", () => {
    expect(totalsFor(items)).toEqual({
      subtotalMinor: 64_500,
      discountMinor: 5_000,
      totalMinor: 59_500,
    });
  });

  it("is zero for an empty list", () => {
    expect(totalsFor([])).toEqual({ subtotalMinor: 0, discountMinor: 0, totalMinor: 0 });
  });

  it("floors at zero rather than producing a refund nobody authorised", () => {
    const overDiscounted: LineItem[] = [
      toLineItem({
        kind: "resource",
        description: "Boat",
        quantity: 1,
        unitAmountMinor: 1_000,
      }),
      toLineItem({
        kind: "discount",
        description: "Oops",
        quantity: 1,
        unitAmountMinor: -9_000,
      }),
    ];
    expect(totalsFor(overDiscounted).totalMinor).toBe(0);
  });
});

describe("depositFor", () => {
  it("takes a whole percent of the total", () => {
    expect(depositFor(60_000, { percent: 30 })).toBe(18_000);
  });

  it("rounds a percentage down, so parts never exceed the whole", () => {
    // 30% of €99.99 is €29.997 — €29.99, not €30.00.
    expect(depositFor(9_999, { percent: 30 })).toBe(2_999);
  });

  it("takes a fixed amount as given", () => {
    expect(depositFor(60_000, { amountMinor: 5_000 })).toBe(5_000);
  });

  it("never exceeds the total — that would owe the customer money at confirmation", () => {
    expect(depositFor(4_000, { amountMinor: 10_000 })).toBe(4_000);
    expect(depositFor(0, { percent: 100 })).toBe(0);
  });

  it("is zero when there is no deposit", () => {
    expect(depositFor(60_000, null)).toBe(0);
  });
});

describe("balanceMinor", () => {
  it("is what is left to pay", () => {
    expect(balanceMinor(60_000, 18_000)).toBe(42_000);
  });

  it("is zero, never negative, when overpaid", () => {
    expect(balanceMinor(60_000, 70_000)).toBe(0);
  });
});

describe("formatMoney", () => {
  it("renders minor units in the currency's own form", () => {
    // Non-breaking spaces vary by ICU build, so the assertion is on the parts
    // that matter rather than on an exact string.
    const formatted = formatMoney(60_000, "EUR");
    expect(formatted).toContain("600.00");
    expect(formatted).toContain("€");
  });
});
