/** Pure helpers behind the admin console's read services. */
import { describe, expect, it } from "vitest";
import { AppError } from "@/server/http/envelope";
import { z } from "zod";
import {
  dayKey,
  escapeRegex,
  fillDailySeries,
  parseOrThrow,
  searchTerm,
  windowStart,
} from "./admin-common";

describe("admin-common", () => {
  it("escapes every regex metacharacter so a search is a literal", () => {
    const pattern = new RegExp(escapeRegex("a.*b(c)?"));
    expect(pattern.test("a.*b(c)?")).toBe(true);
    expect(pattern.test("aXXb")).toBe(false);
  });

  it("trims and caps search text, and treats non-strings as no search", () => {
    expect(searchTerm("  hi  ")).toBe("hi");
    expect(searchTerm("x".repeat(100))).toHaveLength(60);
    expect(searchTerm(undefined)).toBe("");
  });

  it("windowStart is midnight UTC, days-1 back, so today is included", () => {
    const start = windowStart(new Date("2026-09-27T15:30:00Z"), 14);
    expect(start.toISOString()).toBe("2026-09-14T00:00:00.000Z");
    expect(dayKey(start)).toBe("2026-09-14");
  });

  it("fills missing days with zeros and keeps present ones", () => {
    const start = new Date("2026-09-01T00:00:00Z");
    const series = fillDailySeries([{ day: "2026-09-02", count: 5 }], start, 3, ["count"]);
    expect(series).toEqual([
      { day: "2026-09-01", count: 0 },
      { day: "2026-09-02", count: 5 },
      { day: "2026-09-03", count: 0 },
    ]);
  });

  it("parseOrThrow names the failing field in a VALIDATION_FAILED", () => {
    const schema = z.object({ tier: z.enum(["free"]) });
    expect(parseOrThrow(schema, { tier: "free" })).toEqual({ tier: "free" });
    try {
      parseOrThrow(schema, { tier: "gold" }, "params");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION_FAILED");
      expect(JSON.stringify((error as AppError).details)).toContain("tier");
    }
  });
});
