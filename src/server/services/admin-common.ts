/**
 * Small helpers shared by the platform-admin read services added with the
 * admin console (admin-overview, admin-users, admin-entities, admin-audit-read).
 *
 * The older admin services (admin-tenants.ts, admin-activities.ts) carry their
 * own copies of these, deliberately left alone: they are contract code with
 * their own tests, and re-plumbing them buys nothing. Everything here is pure —
 * no driver, no `getDb`.
 */
import { ObjectId } from "mongodb";
import type { z } from "zod";
import { AppError } from "@/server/http/envelope";

export const objectIdHex = /^[0-9a-f]{24}$/i;

/** Long enough for any name, email or key; short enough that a query stays a query. */
export const MAX_SEARCH_LENGTH = 60;

/** A search term is a literal — `.*` from a request must match a dot and a star. */
export const escapeRegex = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const isString = (value: unknown): value is string => typeof value === "string";

export const iso = (value: unknown): string | null =>
  value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null;

export const hexOf = (value: unknown): string | null =>
  value instanceof ObjectId ? value.toHexString() : null;

/** Trimmed, length-capped search text, or "" when there is nothing to search for. */
export const searchTerm = (raw: unknown): string =>
  isString(raw) ? raw.trim().slice(0, MAX_SEARCH_LENGTH) : "";

/**
 * Validates `input` against `schema` and throws the same `VALIDATION_FAILED`
 * shape `parseQuery` does, naming each failing field. Services re-validate
 * rather than trusting the route, so a direct call cannot smuggle a bad value
 * past the boundary.
 */
export function parseOrThrow<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
  source: "query" | "params" = "query",
): z.infer<S> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_FAILED",
      source === "query" ? "Invalid request query" : "Invalid request params",
      {
        source,
        fields: Object.fromEntries(
          parsed.error.issues.map((issue) => [issue.path.join(".") || "(root)", issue.message]),
        ),
      },
    );
  }
  return parsed.data;
}

/** UTC calendar day, `YYYY-MM-DD` — the bucket key every daily series uses. */
export const dayKey = (date: Date): string => date.toISOString().slice(0, 10);

/** Midnight UTC `days - 1` days before `now`, so the window includes today. */
export function windowStart(now: Date, days: number): Date {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return start;
}

/**
 * Dense daily series: one entry per UTC day from `start` for `days` days, with
 * missing days as zero. An aggregation only returns days that had rows, and a
 * chart with gaps silently compresses time — so the gaps are filled here.
 */
export function fillDailySeries<K extends string>(
  rows: readonly ({ day: string } & Partial<Record<K, number>>)[],
  start: Date,
  days: number,
  keys: readonly K[],
): ({ day: string } & Record<K, number>)[] {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const out: ({ day: string } & Record<K, number>)[] = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + i);
    const day = dayKey(date);
    const row = byDay.get(day);
    const entry = { day } as { day: string } & Record<K, number>;
    for (const key of keys) {
      const value = row?.[key];
      (entry as Record<string, number | string>)[key] = typeof value === "number" ? value : 0;
    }
    out.push(entry);
  }
  return out;
}
