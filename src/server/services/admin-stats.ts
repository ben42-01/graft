/**
 * Aggregate tenant counts for the `/admin` dashboard's stat widgets — the
 * summary strip above `TenantTable`, not a new data surface. Same posture as
 * `admin-tenants.ts`: reads `tenants` directly (never `createRepository`,
 * never scoped by `ctx.tenantId`), and every field returned is named, never a
 * spread of an aggregation stage's raw output.
 */
import { getDb } from "@/server/db/mongo";
import { TIERS, type Tier } from "@/server/tiers";

export type AdminStats = Readonly<{
  totalTenants: number;
  byTier: Readonly<Record<Tier, number>>;
  frozenTenants: number;
  inTrial: number;
  inGrace: number;
}>;

export type AdminStatsStore = {
  compute(now: Date): Promise<AdminStats>;
};

const emptyByTier = (): Record<Tier, number> =>
  Object.fromEntries(TIERS.map((tier) => [tier, 0])) as Record<Tier, number>;

export function mongoAdminStatsStore(): AdminStatsStore {
  return {
    async compute(now) {
      const db = await getDb();
      const collection = db.collection("tenants");

      const [tierCounts, totalTenants, frozenTenants, inTrial, inGrace] = await Promise.all([
        collection
          .aggregate<{ _id: string; count: number }>([
            { $group: { _id: "$tier", count: { $sum: 1 } } },
          ])
          .toArray(),
        collection.countDocuments({}),
        collection.countDocuments({ "readOnly.0": { $exists: true } }),
        collection.countDocuments({ "billing.trialEndsAt": { $gt: now } }),
        collection.countDocuments({ "billing.graceExpiresAt": { $gt: now } }),
      ]);

      const byTier = emptyByTier();
      for (const row of tierCounts) {
        if ((TIERS as readonly string[]).includes(row._id)) {
          byTier[row._id as Tier] = row.count;
        }
      }

      return Object.freeze({
        totalTenants,
        byTier: Object.freeze(byTier),
        frozenTenants,
        inTrial,
        inGrace,
      });
    },
  };
}

let defaultStore: AdminStatsStore | undefined;
const store = () => (defaultStore ??= mongoAdminStatsStore());

export async function getAdminStats(
  overrides: Partial<{ store: AdminStatsStore; now: () => Date }> = {},
): Promise<AdminStats> {
  const now = (overrides.now ?? (() => new Date()))();
  return (overrides.store ?? store()).compute(now);
}
