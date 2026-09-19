/**
 * Cross-tenant activity reads for the platform-admin surface (GRAFT-29.2).
 *
 * The write side (GRAFT-29.1, src/server/services/activity-log.ts) owns the
 * `activities` collection's shape and its closed action taxonomy
 * (`ACTIVITY_REGISTRY`). This file is the read-side twin, and follows
 * `admin-tenants.ts`'s precedent in every particular that applies:
 *
 * ## 1. `activities` is read directly, not through the repository layer
 *
 * `activities` is keyed by `tenantId` like any other tenant-scoped collection,
 * but the *caller* here is a platform admin reading across tenants — the same
 * argument admin-tenants.ts makes for `tenants`. `createRepository` is
 * therefore never called from this file, and admin-activities.test.ts mocks it
 * to throw so a future edit that reaches for it fails the suite instead of
 * quietly scoping this surface to the admin's own workspace.
 *
 * ## 2. Every field is an explicit allow-list, never a spread
 *
 * `toActivitySummary` names every top-level key it emits, and `contextFor`
 * names every per-family context key. A field added to a context schema
 * tomorrow does not appear in a response body because nobody remembered to
 * strip it — it does not appear because nobody added it here (AC6).
 *
 * ## 3. `action` is validated against the same registry the writer uses
 *
 * The filter is not free text: it is either an exact `family.leaf` from
 * `ACTIVITY_REGISTRY`, or a family prefix ending in `.` (`"billing."`). Both
 * are checked against the registry so a typo is a 400, not a silently empty
 * list (AC3) — mirroring `admin-tenants.ts`'s AC4 treatment of `tier`.
 *
 * ## 4. `q` searches a declared allow-list of fields, never the whole context
 *
 * `SEARCHABLE_CONTEXT_FIELDS` names the fields, per family, that may be
 * matched by free text. A family that stores something sensitive in context
 * (there is none today, by GRAFT-29.1's own design) is excluded from search
 * by simply not being listed here — no code change needed elsewhere (AC4).
 * The term is escaped to a literal before it reaches Mongo, exactly as
 * `admin-tenants.ts`'s `q` is.
 */
import { ObjectId, type Filter } from "mongodb";
import { z } from "zod";
import { getDb } from "@/server/db/mongo";
import { AppError } from "@/server/http/envelope";
import { clampLimit, decodeCursor, page, type PageMeta } from "@/server/http/pagination";
import {
  ACTIVITY_REGISTRY,
  ACTOR_TYPES,
  type ActivityFamily,
  type ActorType,
} from "./activity-log";

/** The slice of an activity document this surface reads. Nothing else is fetched. */
export type AdminActivityDoc = {
  _id: ObjectId;
  tenantId: ObjectId;
  actorType: ActorType;
  actorId: ObjectId | null;
  action: string;
  ok: boolean;
  requestId: string;
  at: Date;
  context: Record<string, unknown>;
};

export type ActivitySummary = Readonly<{
  id: string;
  tenantId: string;
  actorType: ActorType;
  actorId: string | null;
  action: string;
  ok: boolean;
  at: string;
  context: Readonly<Record<string, unknown>>;
}>;

export type AdminActivityStore = {
  /** One over-fetched page, descending `_id`. The filter is built here, never by a caller. */
  listActivities(filter: Filter<AdminActivityDoc>, limit: number): Promise<AdminActivityDoc[]>;
};

export type AdminActivityDeps = { store: AdminActivityStore };

/** Long enough for any free-text search term; short enough that a query stays a query. */
export const MAX_SEARCH_LENGTH = 60;

const objectIdHex = /^[0-9a-f]{24}$/i;

const isString = (value: unknown): value is string => typeof value === "string";

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * AC3 — an `action` filter is either an exact `family.leaf` or a prefix
 * ending in `.`, and both are checked against `ACTIVITY_REGISTRY` (the same
 * registry GRAFT-29.1 validates writes against) rather than accepted as
 * arbitrary text. A value that names no real family or leaf is invalid.
 *
 * A prefix is *not* required to equal a registry key outright: registry keys
 * are themselves dotted (`notify.email`, `billing.subscription`), so
 * `"billing."` (AC3's own example) is a valid prefix that reaches across two
 * registry families — `billing.subscription` and `billing.payment` — neither
 * of which is spelled `"billing"`. A prefix is therefore valid when some
 * registered family equals it, or is nested under it.
 */
export function isValidActionFilter(value: string): boolean {
  if (value.endsWith(".")) {
    const prefix = value.slice(0, -1);
    if (!prefix) return false;
    return Object.keys(ACTIVITY_REGISTRY).some(
      (family) => family === prefix || family.startsWith(`${prefix}.`),
    );
  }
  const cut = value.lastIndexOf(".");
  if (cut === -1) return false;
  const family = value.slice(0, cut);
  const leaf = value.slice(cut + 1);
  const def = (ACTIVITY_REGISTRY as Record<string, { actions: readonly string[] }>)[family];
  return Boolean(def && def.actions.includes(leaf));
}

export const adminActivityListQuerySchema = z
  .object({
    tenantId: z.string().regex(objectIdHex, "Expected a 24-character id").optional(),
    // AC3 — an unregistered family/leaf is a 400 at the boundary, not an empty list.
    action: z
      .string()
      .min(1)
      .refine(isValidActionFilter, "Unregistered activity action or family")
      .optional(),
    actorType: z.enum(ACTOR_TYPES).optional(),
    // AC5 — ISO dates, validated as parseable rather than with a strict format
    // regex, so both a bare date and a full timestamp are accepted.
    from: z
      .string()
      .refine((value) => !Number.isNaN(Date.parse(value)), "Expected an ISO date")
      .optional(),
    to: z
      .string()
      .refine((value) => !Number.isNaN(Date.parse(value)), "Expected an ISO date")
      .optional(),
    q: z.string().max(MAX_SEARCH_LENGTH).optional(),
    limit: z.string().optional(),
    cursor: z.string().optional(),
  })
  // AC5 — `from` after `to` is invalid; checked here so it is one schema
  // failure rather than a rule enforced separately by the caller.
  .superRefine((value, ctx) => {
    if (!value.from || !value.to) return;
    if (Date.parse(value.from) > Date.parse(value.to)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["from"],
        message: "`from` must not be after `to`",
      });
    }
  });

export type AdminActivityListQuery = z.infer<typeof adminActivityListQuerySchema>;

type ActivityFilter = Filter<AdminActivityDoc>;

/**
 * AC4 — the fields a `q` search may touch, named explicitly per family. A
 * family with no entry here (or an empty list) is simply never searched, which
 * is the mechanism, not an oversight: excluding a sensitive field from search
 * is "do not list it", not a separate code path to maintain.
 *
 * `notify.email`'s `to` is included deliberately (Context, AC4 of the API
 * contract): the raw stored address is what is matched against, even though
 * `toActivitySummary` below only ever emits a masked form of it. Search
 * operates on the collection an admin already has cross-tenant read access
 * to; the mask is strictly a display concern.
 */
const SEARCHABLE_CONTEXT_FIELDS: Record<ActivityFamily, readonly string[]> = {
  "notify.email": ["template", "to"],
  "billing.subscription": ["reason"],
  "billing.payment": [],
  account: [],
  entity: ["entityType"],
};

/** The full set of `context.<field>` paths any family may be searched on. */
const ALL_SEARCHABLE_PATHS: readonly string[] = Array.from(
  new Set(Object.values(SEARCHABLE_CONTEXT_FIELDS).flat()),
);

/**
 * AC6 — the fields a response's `context` may carry, per family. This is the
 * read-side twin of GRAFT-29.1's write-side `ACTIVITY_REGISTRY` context
 * schemas, deliberately kept separate rather than derived from them: a field a
 * family is allowed to *store* is not automatically a field it is allowed to
 * *display*, and the two allow-lists must be kept in sync on purpose (API
 * Contract note), not by one mechanically generating the other.
 */
const DISPLAY_CONTEXT_FIELDS: Record<ActivityFamily, readonly string[]> = {
  "notify.email": ["template", "to"],
  "billing.subscription": ["fromTier", "toTier", "reason"],
  "billing.payment": ["amountCents", "currency", "failureCode"],
  account: ["method"],
  entity: ["entityDefId", "entityType", "recordId"],
};

/**
 * Masks everything left of `@` but the first character, so "what did we send
 * them" stays answerable from the summary without the summary itself carrying
 * a usable address (docs/BACKEND.md security_checklist: "No PII in logs").
 */
function maskEmail(value: unknown): string | undefined {
  if (!isString(value)) return undefined;
  const at = value.indexOf("@");
  if (at <= 0) return "***";
  return `${value.slice(0, 1)}***${value.slice(at)}`;
}

function familyOf(action: string): ActivityFamily | null {
  const cut = action.lastIndexOf(".");
  if (cut === -1) return null;
  const family = action.slice(0, cut);
  return family in ACTIVITY_REGISTRY ? (family as ActivityFamily) : null;
}

/** AC4/AC6 — every key is written out by hand; no spread of `doc.context`. */
function contextFor(doc: AdminActivityDoc): Readonly<Record<string, unknown>> {
  const family = familyOf(doc.action);
  if (!family) return Object.freeze({});

  const fields = DISPLAY_CONTEXT_FIELDS[family];
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = doc.context?.[field];
    if (raw === undefined) continue;
    out[field] = family === "notify.email" && field === "to" ? maskEmail(raw) : raw;
  }
  return Object.freeze(out);
}

/** AC1 + AC6. Every key is written out by hand — see the header note. */
export function toActivitySummary(doc: AdminActivityDoc): ActivitySummary {
  return Object.freeze({
    id: doc._id.toHexString(),
    tenantId: doc.tenantId.toHexString(),
    actorType: doc.actorType,
    actorId: doc.actorId ? doc.actorId.toHexString() : null,
    action: doc.action,
    ok: doc.ok,
    at: doc.at.toISOString(),
    context: contextFor(doc),
  });
}

/** Built here, from validated input only — a client filter never reaches Mongo. */
export function buildActivityFilter(query: AdminActivityListQuery): ActivityFilter {
  const filter: ActivityFilter = {};

  if (query.tenantId) filter.tenantId = new ObjectId(query.tenantId);
  if (query.actorType) filter.actorType = query.actorType;

  if (query.action) {
    filter.action = query.action.endsWith(".")
      ? { $regex: `^${escapeRegex(query.action)}` }
      : query.action;
  }

  if (query.from || query.to) {
    const at: { $gte?: Date; $lte?: Date } = {};
    if (query.from) at.$gte = new Date(query.from);
    if (query.to) at.$lte = new Date(query.to);
    filter.at = at;
  }

  if (query.cursor) {
    // `decodeCursor` refuses anything this API did not issue, so a crafted
    // cursor is a 400 rather than an unbounded scan.
    filter._id = { $lt: new ObjectId(decodeCursor(query.cursor).id) };
  }

  const q = isString(query.q) ? query.q.trim().slice(0, MAX_SEARCH_LENGTH) : "";
  if (q && ALL_SEARCHABLE_PATHS.length > 0) {
    const $regex = escapeRegex(q);
    filter.$or = ALL_SEARCHABLE_PATHS.map((path) => ({
      [`context.${path}`]: { $regex, $options: "i" },
    })) as ActivityFilter["$or"];
  }

  return filter;
}

export function mongoAdminActivityStore(): AdminActivityStore {
  return {
    async listActivities(filter, limit) {
      const db = await getDb();
      return (
        db
          .collection<AdminActivityDoc>("activities")
          .find(filter)
          // Descending `_id` is the stable sort the opaque cursor is issued
          // against (AC1): newest first, and unique, so no row can straddle a
          // page boundary the way an `at` tie could.
          .sort({ _id: -1 })
          .limit(limit)
          .toArray()
      );
    },
  };
}

function resolveDeps(overrides: Partial<AdminActivityDeps> = {}): AdminActivityDeps {
  return { store: overrides.store ?? mongoAdminActivityStore() };
}

/**
 * AC1–AC5. One page of activity rows, across every tenant unless `tenantId`
 * narrows it, in no way scoped by the caller's own membership. The query is
 * re-validated here rather than trusted from the route, so a direct service
 * call cannot smuggle an unregistered action or a malformed date past the Zod
 * boundary.
 */
export async function listAdminActivities(
  query: unknown,
  overrides: Partial<AdminActivityDeps> = {},
): Promise<{ items: ActivitySummary[]; meta: PageMeta }> {
  const parsed = adminActivityListQuerySchema.safeParse(query ?? {});
  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", "Invalid request query", {
      source: "query",
      fields: Object.fromEntries(
        parsed.error.issues.map((issue) => [issue.path.join(".") || "(root)", issue.message]),
      ),
    });
  }

  const { store } = resolveDeps(overrides);
  const limit = clampLimit(parsed.data.limit);
  // One extra row is how `hasMore` is known without a second count query.
  const rows = await store.listActivities(buildActivityFilter(parsed.data), limit + 1);
  const paged = page(rows, limit, (row) => ({ id: row._id.toHexString() }));
  return { items: paged.items.map(toActivitySummary), meta: paged.meta };
}
