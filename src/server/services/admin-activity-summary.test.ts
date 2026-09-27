/** Activity Monitor aggregates: range resolution, bucketing and shaping. */
import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { AppError } from "@/server/http/envelope";
import {
  fillBuckets,
  MAX_BUCKETS,
  resolveRange,
  summarizeAdminActivities,
  type ActivitySummaryStore,
  type SummaryRaw,
} from "./admin-activity-summary";

const now = new Date("2026-09-27T12:34:00Z");

describe("resolveRange", () => {
  it("defaults to the last seven days, bucketed by day", () => {
    const range = resolveRange(undefined, undefined, now);
    expect(range.to).toEqual(now);
    expect(range.from.toISOString()).toBe("2026-09-20T12:34:00.000Z");
    expect(range.bucket).toBe("day");
  });

  it("buckets a range of two days or less by hour", () => {
    expect(resolveRange("2026-09-26T12:00:00Z", "2026-09-27T12:00:00Z", now).bucket).toBe(
      "hour",
    );
  });
});

describe("fillBuckets", () => {
  it("is dense and splits ok from failed", () => {
    const series = fillBuckets(
      [{ at: new Date("2026-09-27T10:00:00Z"), total: 5, failed: 2 }],
      new Date("2026-09-27T09:15:00Z"),
      new Date("2026-09-27T11:05:00Z"),
      "hour",
    );
    expect(series).toEqual([
      { at: "2026-09-27T09:00:00.000Z", ok: 0, failed: 0 },
      { at: "2026-09-27T10:00:00.000Z", ok: 3, failed: 2 },
      { at: "2026-09-27T11:00:00.000Z", ok: 0, failed: 0 },
    ]);
  });

  it("caps a long range to the most recent MAX_BUCKETS", () => {
    const series = fillBuckets([], new Date("2025-01-01T00:00:00Z"), now, "day");
    expect(series).toHaveLength(MAX_BUCKETS);
    expect(series.at(-1)?.at).toBe("2026-09-27T00:00:00.000Z");
  });
});

describe("summarizeAdminActivities", () => {
  const raw: SummaryRaw = {
    total: 10,
    failed: 2,
    byFamily: [{ key: "account", total: 6, failed: 1 }],
    byActorType: [{ key: "customer", total: 10, failed: 2 }],
    topActions: [{ key: "account.login", total: 6, failed: 1 }],
    topTenants: [{ key: new ObjectId().toHexString(), total: 10, failed: 2 }],
    series: [],
  };

  it("reuses the list filter (without the cursor) over the resolved range", async () => {
    let seen: Record<string, unknown> = {};
    const store: ActivitySummaryStore = {
      summarize: async (filter, bucket) => {
        seen = { filter, bucket };
        return raw;
      },
      tenantLabels: async (ids) =>
        new Map(ids.map((id) => [id.toHexString(), { name: "Acme", slug: "acme" }])),
    };
    const report = await summarizeAdminActivities(
      { ok: "false", actorType: "customer" },
      { store, now: () => now },
    );
    const filter = seen.filter as Record<string, unknown>;
    expect(filter.ok).toBe(false);
    expect(filter.actorType).toBe("customer");
    expect(filter._id).toBeUndefined();
    expect(seen.bucket).toBe("day");
    expect(report.failureRate).toBeCloseTo(0.2);
    expect(report.ok).toBe(8);
    expect(report.topTenants[0]?.tenantName).toBe("Acme");
    expect(report.byFamily).toEqual([{ family: "account", total: 6, failed: 1 }]);
  });

  it("reports a zero failure rate on an empty range rather than NaN", async () => {
    const store: ActivitySummaryStore = {
      summarize: async () => ({ ...raw, total: 0, failed: 0, topTenants: [] }),
      tenantLabels: async () => new Map(),
    };
    const report = await summarizeAdminActivities({}, { store, now: () => now });
    expect(report.failureRate).toBe(0);
  });

  it("rejects an unregistered action with VALIDATION_FAILED", async () => {
    const store = { summarize: async () => raw, tenantLabels: async () => new Map() };
    await expect(
      summarizeAdminActivities({ action: "nope.nope" }, { store }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
