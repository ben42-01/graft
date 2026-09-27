/**
 * The platform overview behind `/admin` — the admin console's dashboard.
 *
 * Where `admin-stats.ts` answers "how are tenants distributed across tiers",
 * this answers "what does the whole platform look like right now": how many
 * accounts, users and subscriptions exist, how much is being built on it
 * (entities, records, forms, orders), and what the last two weeks of signups
 * and activity look like.
 *
 * Same posture as every admin read (admin-tenants.ts header): collections are
 * read directly and across tenants, never through `createRepository`; nothing
 * is scoped by `ctx.tenantId`; and the response is counts only — no tenant
 * name, no user email, no id. A number cannot leak a person.
 */
import { getDb } from "@/server/db/mongo";
import { TIERS, type Tier } from "@/server/tiers";
import { fillDailySeries, windowStart } from "./admin-common";

/** Days of history on the dashboard's trend charts. */
export const OVERVIEW_DAYS = 14;

export type OverviewCounts = {
  tenants: {
    total: number;
    byTier: Record<Tier, number>;
    new7d: number;
    new30d: number;
    frozen: number;
  };
  subscriptions: { active: number; inTrial: number; inGrace: number; withCustomer: number };
  users: {
    total: number;
    verified: number;
    platformAdmins: number;
    new7d: number;
    new30d: number;
  };
  content: {
    entityDefs: number;
    records: number;
    forms: number;
    publishedForms: number;
    submissions: number;
    orders: number;
  };
  activity: { last24h: number; failed24h: number };
};

type DailyRow = { day: string; count?: number; ok?: number; failed?: number };

export type OverviewRaw = OverviewCounts & {
  series: { signups: DailyRow[]; tenants: DailyRow[]; activity: DailyRow[] };
};

export type AdminOverview = OverviewCounts & {
  window: { from: string; days: number };
  series: {
    signups: { day: string; count: number }[];
    tenants: { day: string; count: number }[];
    activity: { day: string; ok: number; failed: number }[];
  };
};

export type AdminOverviewStore = {
  compute(now: Date, seriesFrom: Date): Promise<OverviewRaw>;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const emptyByTier = (): Record<Tier, number> =>
  Object.fromEntries(TIERS.map((tier) => [tier, 0])) as Record<Tier, number>;

/** `$group` by UTC day of `field`, from `from` onward. */
const dailyCount = (field: string, from: Date) => [
  { $match: { [field]: { $gte: from } } },
  {
    $group: {
      _id: { $dateToString: { format: "%Y-%m-%d", date: `$${field}`, timezone: "UTC" } },
      count: { $sum: 1 },
    },
  },
];

export function mongoAdminOverviewStore(): AdminOverviewStore {
  return {
    async compute(now, seriesFrom) {
      const db = await getDb();
      const tenants = db.collection("tenants");
      const users = db.collection("users");
      const activities = db.collection("activities");
      const since7d = new Date(now.getTime() - 7 * DAY_MS);
      const since30d = new Date(now.getTime() - 30 * DAY_MS);
      const since24h = new Date(now.getTime() - DAY_MS);
      const live = { deletedAt: null };

      const [
        tierRows,
        tenantTotal,
        tenantNew7d,
        tenantNew30d,
        frozen,
        active,
        inTrial,
        inGrace,
        withCustomer,
        userTotal,
        verified,
        platformAdmins,
        userNew7d,
        userNew30d,
        entityDefs,
        records,
        forms,
        publishedForms,
        submissions,
        orders,
        last24h,
        failed24h,
        signupRows,
        tenantRows,
        activityRows,
      ] = await Promise.all([
        tenants
          .aggregate<{ _id: string; count: number }>([
            { $group: { _id: "$tier", count: { $sum: 1 } } },
          ])
          .toArray(),
        tenants.countDocuments({}),
        tenants.countDocuments({ createdAt: { $gte: since7d } }),
        tenants.countDocuments({ createdAt: { $gte: since30d } }),
        tenants.countDocuments({ "readOnly.0": { $exists: true } }),
        tenants.countDocuments({ "billing.stripeSubscriptionId": { $nin: [null, ""] } }),
        tenants.countDocuments({ "billing.trialEndsAt": { $gt: now } }),
        tenants.countDocuments({ "billing.graceExpiresAt": { $gt: now } }),
        tenants.countDocuments({ "billing.stripeCustomerId": { $nin: [null, ""] } }),
        users.countDocuments({}),
        users.countDocuments({ emailVerifiedAt: { $ne: null } }),
        users.countDocuments({ isPlatformAdmin: true }),
        users.countDocuments({ createdAt: { $gte: since7d } }),
        users.countDocuments({ createdAt: { $gte: since30d } }),
        db.collection("entity_defs").countDocuments(live),
        db.collection("records").countDocuments(live),
        db.collection("forms").countDocuments({}),
        db.collection("forms").countDocuments({ published: true }),
        db.collection("form_submissions").countDocuments({}),
        db.collection("orders").countDocuments({}),
        activities.countDocuments({ at: { $gte: since24h } }),
        activities.countDocuments({ at: { $gte: since24h }, ok: false }),
        users
          .aggregate<{ _id: string; count: number }>(dailyCount("createdAt", seriesFrom))
          .toArray(),
        tenants
          .aggregate<{ _id: string; count: number }>(dailyCount("createdAt", seriesFrom))
          .toArray(),
        activities
          .aggregate<{ _id: string; ok: number; failed: number }>([
            { $match: { at: { $gte: seriesFrom } } },
            {
              $group: {
                _id: { $dateToString: { format: "%Y-%m-%d", date: "$at", timezone: "UTC" } },
                ok: { $sum: { $cond: ["$ok", 1, 0] } },
                failed: { $sum: { $cond: ["$ok", 0, 1] } },
              },
            },
          ])
          .toArray(),
      ]);

      const byTier = emptyByTier();
      for (const row of tierRows) {
        if ((TIERS as readonly string[]).includes(row._id)) byTier[row._id as Tier] = row.count;
      }

      return {
        tenants: {
          total: tenantTotal,
          byTier,
          new7d: tenantNew7d,
          new30d: tenantNew30d,
          frozen,
        },
        subscriptions: { active, inTrial, inGrace, withCustomer },
        users: {
          total: userTotal,
          verified,
          platformAdmins,
          new7d: userNew7d,
          new30d: userNew30d,
        },
        content: { entityDefs, records, forms, publishedForms, submissions, orders },
        activity: { last24h, failed24h },
        series: {
          signups: signupRows.map((row) => ({ day: row._id, count: row.count })),
          tenants: tenantRows.map((row) => ({ day: row._id, count: row.count })),
          activity: activityRows.map((row) => ({
            day: row._id,
            ok: row.ok,
            failed: row.failed,
          })),
        },
      };
    },
  };
}

let defaultStore: AdminOverviewStore | undefined;
const store = () => (defaultStore ??= mongoAdminOverviewStore());

/**
 * Every field is named — the store's raw series are re-shaped into dense,
 * gap-filled daily arrays here, so a quiet day is a zero on the chart rather
 * than a day that silently isn't there.
 */
export async function getAdminOverview(
  overrides: Partial<{ store: AdminOverviewStore; now: () => Date }> = {},
): Promise<AdminOverview> {
  const now = (overrides.now ?? (() => new Date()))();
  const from = windowStart(now, OVERVIEW_DAYS);
  const raw = await (overrides.store ?? store()).compute(now, from);

  return {
    tenants: {
      total: raw.tenants.total,
      byTier: { ...emptyByTier(), ...raw.tenants.byTier },
      new7d: raw.tenants.new7d,
      new30d: raw.tenants.new30d,
      frozen: raw.tenants.frozen,
    },
    subscriptions: {
      active: raw.subscriptions.active,
      inTrial: raw.subscriptions.inTrial,
      inGrace: raw.subscriptions.inGrace,
      withCustomer: raw.subscriptions.withCustomer,
    },
    users: {
      total: raw.users.total,
      verified: raw.users.verified,
      platformAdmins: raw.users.platformAdmins,
      new7d: raw.users.new7d,
      new30d: raw.users.new30d,
    },
    content: {
      entityDefs: raw.content.entityDefs,
      records: raw.content.records,
      forms: raw.content.forms,
      publishedForms: raw.content.publishedForms,
      submissions: raw.content.submissions,
      orders: raw.content.orders,
    },
    activity: { last24h: raw.activity.last24h, failed24h: raw.activity.failed24h },
    window: { from: from.toISOString(), days: OVERVIEW_DAYS },
    series: {
      signups: fillDailySeries(raw.series.signups, from, OVERVIEW_DAYS, ["count"]),
      tenants: fillDailySeries(raw.series.tenants, from, OVERVIEW_DAYS, ["count"]),
      activity: fillDailySeries(raw.series.activity, from, OVERVIEW_DAYS, ["ok", "failed"]),
    },
  };
}
