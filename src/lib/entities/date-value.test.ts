/**
 * The string a date field holds. The rules worth pinning are the ones that
 * silently corrupt a booking if they are wrong: local time, and a day that
 * survives changing the time (and vice versa).
 */
import { describe, expect, it } from "vitest";
import { formatDateValue, parseDateValue, timeOf, toDateValue, withTimeOf } from "./date-value";

describe("toDateValue", () => {
  it("writes the local day, not the UTC one", () => {
    // 23:30 local on the 20th is the 21st in UTC anywhere east of Greenwich.
    expect(toDateValue(new Date(2026, 8, 20, 23, 30))).toBe("2026-09-20");
  });

  it("adds the clock time only when the field carries one", () => {
    const date = new Date(2026, 8, 20, 9, 5);
    expect(toDateValue(date, true)).toBe("2026-09-20T09:05");
    expect(toDateValue(date)).toBe("2026-09-20");
  });
});

describe("parseDateValue", () => {
  it("reads a bare day as local midnight, so it cannot land on the day before", () => {
    const parsed = parseDateValue("2026-09-20");
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(8);
    expect(parsed?.getDate()).toBe(20);
    expect(parsed?.getHours()).toBe(0);
  });

  it("reads a day and time as that clock time", () => {
    expect(parseDateValue("2026-09-20T14:45")?.getHours()).toBe(14);
    expect(parseDateValue("2026-09-20T14:45")?.getMinutes()).toBe(45);
  });

  it("refuses a day that does not exist rather than rolling it over", () => {
    expect(parseDateValue("2026-02-31")).toBeNull();
    expect(parseDateValue("2026-13-01")).toBeNull();
  });

  it("refuses anything that is not a date at all", () => {
    expect(parseDateValue("")).toBeNull();
    expect(parseDateValue("next tuesday")).toBeNull();
  });

  it("round-trips whatever toDateValue wrote", () => {
    const date = new Date(2026, 0, 2, 7, 8);
    expect(parseDateValue(toDateValue(date, true))?.getTime()).toBe(date.getTime());
  });
});

describe("withTimeOf / timeOf", () => {
  it("changes the time without losing the day", () => {
    expect(withTimeOf("2026-09-20T09:00", "17:30")).toBe("2026-09-20T17:30");
  });

  it("changes the day without losing the time", () => {
    const moved = withTimeOf("2026-09-22", timeOf("2026-09-20T10:00"));
    expect(moved).toBe("2026-09-22T10:00");
  });

  it("drops to a bare day when the time is cleared", () => {
    expect(withTimeOf("2026-09-20T10:00", "")).toBe("2026-09-20");
  });

  it("leaves a value with no usable day alone", () => {
    expect(withTimeOf("", "10:00")).toBe("");
  });

  it("reads no time out of a bare day", () => {
    expect(timeOf("2026-09-20")).toBe("");
  });
});

describe("formatDateValue", () => {
  it("says nothing when nothing is chosen", () => {
    expect(formatDateValue("")).toBe("");
  });

  it("reads as a date a person would say, with the time when there is one", () => {
    const withoutTime = formatDateValue("2026-09-20", "en-GB");
    expect(withoutTime).toContain("2026");
    expect(withoutTime).not.toContain("at");
    expect(formatDateValue("2026-09-20T10:00", "en-GB")).toContain("at 10:00");
  });
});
