/**
 * `getAdminStats` — the `/admin/tenants` dashboard widgets' data source
 * (src/components/admin/stats-widgets.tsx). Ad hoc addition, not a GRAFT
 * contract issue; tested to the same bar as the rest of the admin surface
 * (an allow-listed, store-backed aggregate — no `createRepository`, since
 * this reads across every tenant same as `admin-tenants.ts`).
 */
import { describe, expect, it } from "vitest";
import { getAdminStats, type AdminStats, type AdminStatsStore } from "./admin-stats";

const fixedStats: AdminStats = Object.freeze({
  totalTenants: 3,
  byTier: Object.freeze({ free: 2, premium: 1, enterprise: 0 }),
  frozenTenants: 1,
  inTrial: 1,
  inGrace: 0,
});

const storeReturning = (stats: AdminStats): AdminStatsStore => ({
  compute: async () => stats,
});

describe("getAdminStats", () => {
  it("returns exactly what the store computed", async () => {
    const result = await getAdminStats({ store: storeReturning(fixedStats) });
    expect(result).toEqual(fixedStats);
  });

  it("passes the injected `now`, never trusting the store to know the time", async () => {
    let seen: Date | undefined;
    const store: AdminStatsStore = {
      compute: async (now) => {
        seen = now;
        return fixedStats;
      },
    };
    const now = new Date("2026-06-01T00:00:00.000Z");
    await getAdminStats({ store, now: () => now });
    expect(seen).toEqual(now);
  });
});
