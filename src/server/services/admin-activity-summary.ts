/**
 * Aggregates over the activity log for the admin console's Activity Monitor:
 * volume over time, failure rate, and which families, actions and tenants the
 * activity is coming from.
 *
 * It takes exactly the same filters as the list (`adminActivityListQuerySchema`
 * and `buildActivityFilter` from admin-activities.ts are reused, not copied),
 * so the charts above the table always describe the rows below it. `cursor`
 * and `limit` are ignored — a summary is of the whole filtered set, not a page.
 *
 * Output is counts, actions and tenant labels only; no `context` field is ever
 * read, so the masked-recipient rule in admin-activities.ts cannot be bypassed
 * from here.
 */
import { ObjectId, type Filter } from "mongodb";
import { getDb } from "@/server/db/mongo";
import {
  adminActivityListQuerySchema,
  buildActivityFilter,
  type AdminActivityDoc,
} from "./admin-activities";
import { parseOrThrow } from "./admin-common";
import { mongoTenantLabels, type TenantLabel } from "./admin-users";

/** Default look-back when the caller gives no `from`. */
export const DEFAULT_SUMMARY_DAYS = 7;
/** Ranges up to this long are bucketed by hour; anything longer, by day. */
export const HOURLY_MAX_MS = 2 * 24 * 60 * 60 * 1000;
/** A daily range longer than this would be an unreadable chart; it is capped. */
export const MAX_BUCKETS = 90;

const TOP_ACTIONS = 10;
const TOP_TENANTS = 8;

export type Bucket = "hour" | "day";

type CountRow = { key: string; total: number; failed: number };

export type SummaryRaw = {
  total: number;
  failed: number;
  byFamily: CountRow[];
  byActorType: CountRow[];
  topActions: CountRow[];
  topTenants: CountRow[];
  series: { at: Date; total: number; failed: number }[];
};

export type ActivitySummaryReport = {
  range: { from: string; to: string; bucket: Bucket };
  total: number;
  ok: number;
  failed: number;
  failureRate: number;
  byFamily: { family: string; total: number; failed: number }[];
  byActorType: { actorType: string; total: number; failed: number }[];
  topActions: { action: string; total: number; failed: number }[];
  topTenants: {
    tenantId: string;
    tenantName: string | null;
    tenantSlug: string | null;
    total: number;
    failed: number;
  }[];
  series: { at: string; ok: number; failed: number }[];
};

export type ActivitySummaryStore = {
  summarize(filter: Filter<AdminActivityDoc>, bucket: Bucket): Promise<SummaryRaw>;
  tenantLabels(ids: ObjectId[]): Promise<Map<string, TenantLabel>>;
};

/** The range the summary covers: the caller's, or the last seven days. */
export function resolveRange(
  from: string | undefined,
  to: string | undefined,
  now: Date,
): { from: Date; to: Date; bucket: Bucket } {
  const end = to ? new Date(to) : now;
  const start = from
    ? new Date(from)
    : new Date(end.getTime() - DEFAULT_SUMMARY_DAYS * 24 * 60 * 60 * 1000);
  const bucket: Bucket = end.getTime() - start.getTime() <= HOURLY_MAX_MS ? "hour" : "day";
  return { from: start, to: end, bucket };
}

const truncate = (date: Date, bucket: Bucket): Date => {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  if (bucket === "day") d.setUTCHours(0);
  return d;
};

/**
 * Dense series from `from` to `to` inclusive, one entry per bucket, zeros for
 * empty buckets. Capped at `MAX_BUCKETS` (the most recent ones win).
 */
export function fillBuckets(
  rows: SummaryRaw["series"],
  from: Date,
  to: Date,
  bucket: Bucket,
): ActivitySummaryReport["series"] {
  const step = bucket === "hour" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const byTime = new Map(rows.map((row) => [truncate(row.at, bucket).getTime(), row]));
  const out: ActivitySummaryReport["series"] = [];
  const last = truncate(to, bucket).getTime();
  let cursor = Math.max(truncate(from, bucket).getTime(), last - (MAX_BUCKETS - 1) * step);
  for (; cursor <= last; cursor += step) {
    const row = byTime.get(cursor);
    const total = row?.total ?? 0;
    const failed = row?.failed ?? 0;
    out.push({ at: new Date(cursor).toISOString(), ok: total - failed, failed });
  }
  return out;
}

const groupStage = (key: unknown) => ({
  $group: {
    _id: key,
    total: { $sum: 1 },
    failed: { $sum: { $cond: ["$ok", 0, 1] } },
  },
});

const rows = (docs: { _id: unknown; total: number; failed: number }[]): CountRow[] =>
  docs.map((doc) => ({
    key: doc._id instanceof ObjectId ? doc._id.toHexString() : String(doc._id ?? ""),
    total: doc.total,
    failed: doc.failed,
  }));

export function mongoActivitySummaryStore(): ActivitySummaryStore {
  return {
    async summarize(filter, bucket) {
      const db = await getDb();
      const [facets] = await db
        .collection<AdminActivityDoc>("activities")
        .aggregate<{
          totals: { total: number; failed: number }[];
          byFamily: { _id: string; total: number; failed: number }[];
          byActorType: { _id: string; total: number; failed: number }[];
          topActions: { _id: string; total: number; failed: number }[];
          topTenants: { _id: ObjectId; total: number; failed: number }[];
          series: { _id: Date; total: number; failed: number }[];
        }>([
          { $match: filter },
          {
            $facet: {
              totals: [groupStage(null)],
              // The family is everything before the last dot of `action`.
              byFamily: [
                {
                  $addFields: {
                    _family: {
                      $let: {
                        vars: { parts: { $split: ["$action", "."] } },
                        in: {
                          $reduce: {
                            input: {
                              $slice: ["$$parts", { $subtract: [{ $size: "$$parts" }, 1] }],
                            },
                            initialValue: "",
                            in: {
                              $cond: [
                                { $eq: ["$$value", ""] },
                                "$$this",
                                { $concat: ["$$value", ".", "$$this"] },
                              ],
                            },
                          },
                        },
                      },
                    },
                  },
                },
                groupStage("$_family"),
                { $sort: { total: -1 } },
              ],
              byActorType: [groupStage("$actorType"), { $sort: { total: -1 } }],
              topActions: [
                groupStage("$action"),
                { $sort: { total: -1 } },
                { $limit: TOP_ACTIONS },
              ],
              topTenants: [
                groupStage("$tenantId"),
                { $sort: { total: -1 } },
                { $limit: TOP_TENANTS },
              ],
              series: [
                groupStage({ $dateTrunc: { date: "$at", unit: bucket, timezone: "UTC" } }),
              ],
            },
          },
        ])
        .toArray();

      const totals = facets?.totals[0] ?? { total: 0, failed: 0 };
      return {
        total: totals.total,
        failed: totals.failed,
        byFamily: rows(facets?.byFamily ?? []),
        byActorType: rows(facets?.byActorType ?? []),
        topActions: rows(facets?.topActions ?? []),
        topTenants: rows(facets?.topTenants ?? []),
        series: (facets?.series ?? []).map((row) => ({
          at: row._id,
          total: row.total,
          failed: row.failed,
        })),
      };
    },
    tenantLabels: mongoTenantLabels,
  };
}

export async function summarizeAdminActivities(
  query: unknown,
  overrides: Partial<{ store: ActivitySummaryStore; now: () => Date }> = {},
): Promise<ActivitySummaryReport> {
  const parsed = parseOrThrow(adminActivityListQuerySchema, query);
  const store = overrides.store ?? mongoActivitySummaryStore();
  const now = (overrides.now ?? (() => new Date()))();
  const range = resolveRange(parsed.from, parsed.to, now);

  const filter = buildActivityFilter({
    ...parsed,
    cursor: undefined,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
  });
  const raw = await store.summarize(filter, range.bucket);
  const labels = await store.tenantLabels(
    raw.topTenants
      .filter((row) => ObjectId.isValid(row.key))
      .map((row) => new ObjectId(row.key)),
  );

  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString(), bucket: range.bucket },
    total: raw.total,
    ok: raw.total - raw.failed,
    failed: raw.failed,
    failureRate: raw.total > 0 ? raw.failed / raw.total : 0,
    byFamily: raw.byFamily.map((row) => ({
      family: row.key,
      total: row.total,
      failed: row.failed,
    })),
    byActorType: raw.byActorType.map((row) => ({
      actorType: row.key,
      total: row.total,
      failed: row.failed,
    })),
    topActions: raw.topActions.map((row) => ({
      action: row.key,
      total: row.total,
      failed: row.failed,
    })),
    topTenants: raw.topTenants.map((row) => ({
      tenantId: row.key,
      tenantName: labels.get(row.key)?.name ?? null,
      tenantSlug: labels.get(row.key)?.slug ?? null,
      total: row.total,
      failed: row.failed,
    })),
    series: fillBuckets(raw.series, range.from, range.to, range.bucket),
  };
}
