/** `getAdminOverview` — the `/admin` dashboard's data source. */
import { describe, expect, it } from "vitest";
import {
  getAdminOverview,
  OVERVIEW_DAYS,
  type AdminOverviewStore,
  type OverviewRaw,
} from "./admin-overview";

const raw = (over: Partial<OverviewRaw> = {}): OverviewRaw => ({
  tenants: {
    total: 3,
    byTier: { free: 2, premium: 1, enterprise: 0 },
    new7d: 1,
    new30d: 2,
    frozen: 0,
  },
  subscriptions: { active: 1, inTrial: 1, inGrace: 0, withCustomer: 1 },
  users: { total: 5, verified: 4, platformAdmins: 1, new7d: 2, new30d: 5 },
  content: {
    entityDefs: 7,
    records: 90,
    forms: 3,
    publishedForms: 2,
    submissions: 11,
    orders: 4,
  },
  activity: { last24h: 12, failed24h: 1 },
  series: { signups: [], tenants: [], activity: [] },
  ...over,
});

describe("getAdminOverview", () => {
  const now = new Date("2026-09-27T12:00:00Z");

  it("passes the window start to the store and returns dense 14-day series", async () => {
    let seenFrom: Date | undefined;
    const store: AdminOverviewStore = {
      compute: async (_now, from) => {
        seenFrom = from;
        return raw({
          series: {
            signups: [{ day: "2026-09-27", count: 3 }],
            tenants: [],
            activity: [{ day: "2026-09-20", ok: 4, failed: 1 }],
          },
        });
      },
    };
    const result = await getAdminOverview({ store, now: () => now });

    expect(seenFrom?.toISOString()).toBe("2026-09-14T00:00:00.000Z");
    expect(result.window).toEqual({ from: "2026-09-14T00:00:00.000Z", days: OVERVIEW_DAYS });
    expect(result.series.signups).toHaveLength(OVERVIEW_DAYS);
    expect(result.series.signups.at(-1)).toEqual({ day: "2026-09-27", count: 3 });
    expect(result.series.tenants.every((d) => d.count === 0)).toBe(true);
    expect(result.series.activity.find((d) => d.day === "2026-09-20")).toEqual({
      day: "2026-09-20",
      ok: 4,
      failed: 1,
    });
  });

  it("is an allow-list: a stray field on the store's output never reaches the response", async () => {
    const leaky = raw();
    (leaky.users as Record<string, unknown>).emails = ["someone@example.test"];
    const result = await getAdminOverview({
      store: { compute: async () => leaky },
      now: () => now,
    });
    expect(JSON.stringify(result)).not.toContain("someone@example.test");
    expect(result.content.records).toBe(90);
    expect(result.tenants.byTier).toEqual({ free: 2, premium: 1, enterprise: 0 });
  });
});
