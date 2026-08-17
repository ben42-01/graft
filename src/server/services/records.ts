/**
 * Polymorphic records — the data rows for a tenant-defined entity (GRAFT-07,
 * docs/Graft.md §4.2, docs/BACKEND.md §2, §6).
 *
 * `records` is one collection for every entity a tenant defines; a document is
 * only ever `{ tenantId, entityDefId, schemaVersion, data }`. Three things
 * matter enough to call out:
 *
 *   - **The filter/sort grammar is a whitelist, not an escaping problem.** A
 *     filter or sort key must equal one of the entity's own field keys (plus
 *     `createdAt`/`updatedAt` for sort) or the request is 400. Since field keys
 *     are themselves constrained to `/^[a-z][a-z0-9_]*$/` at entity-creation
 *     time (src/server/services/entities.ts), a Mongo operator key like
 *     `$where` can never be a member of that whitelist — NoSQL injection is
 *     impossible by construction, not by escaping (AC3).
 *   - **Pagination is keyset, not offset**, so it stays correct under a custom
 *     sort. The cursor carries the sort field's value (`at`) alongside the
 *     `_id` tie-breaker (`id`) that `src/server/http/pagination.ts` already
 *     reserved for exactly this. The default sort (`createdAt` desc) needs no
 *     compound cursor conceptually, but uses the same machinery for one code
 *     path rather than two.
 *   - **Lazy migration only ever *drops* fields the entity definition no
 *     longer has.** There is no default to invent for a newly-required field
 *     the old row never collected, so a migrated row is re-validated the next
 *     time it is written, not silently repaired.
 */
import { ObjectId, type Filter, type FindOptions, type WithId } from "mongodb";
import { z } from "zod";
import type { Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  type CursorPayload,
} from "@/server/http/pagination";
import { parse } from "@/server/http/validate";
import {
  compileFieldSchema,
  getCompiledSchema,
  getEntity as getEntityDefault,
  type EntityView,
  type FieldDef,
} from "./entities";
import { consumeQuota as consumeQuotaDefault, type Meter, type QuotaResult } from "./meters";
import { createRepository, type Repository } from "@/server/repositories/base";

const objectIdHex = z.string().regex(/^[0-9a-f]{24}$/i, "Expected a 24-character id");

export const listRecordsParamSchema = z.object({ entityId: objectIdHex });
export const recordParamSchema = z.object({ entityId: objectIdHex, recordId: objectIdHex });

export const listRecordsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.union([z.string(), z.number()]).optional(),
  filter: z.string().optional(),
  sort: z.string().optional(),
});

export const getRecordQuerySchema = z.object({
  includeDeleted: z.string().optional(),
});

export type RecordDoc = {
  tenantId: ObjectId;
  entityDefId: ObjectId;
  schemaVersion: number;
  data: Record<string, unknown>;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RecordView = {
  id: string;
  entityId: string;
  schemaVersion: number;
  data: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

function toObjectId(id: string): ObjectId {
  return new ObjectId(id);
}

function toView(
  doc: Pick<RecordDoc, "schemaVersion" | "data" | "createdAt" | "updatedAt"> & {
    _id: ObjectId;
  },
  entityId: string,
): RecordView {
  return {
    id: doc._id.toHexString(),
    entityId,
    schemaVersion: doc.schemaVersion,
    data: doc.data,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

const invalidQuery = (field: "filter" | "sort" | "cursor", message: string) =>
  new AppError("VALIDATION_FAILED", "Invalid request query", {
    source: "query",
    fields: { [field]: message },
  });

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

type FilterValue = string | number | boolean | null;

const isFilterValue = (value: unknown): value is FilterValue =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

/**
 * AC3, AC4 — every key must name an actual field on the entity. A Mongo
 * operator key (`$where`, `$ne`, a raw `$gt`) is never a field key, so it is
 * rejected as "unknown field" the same way a typo would be, not specially
 * detected and blocked.
 */
export function parseFilterGrammar(
  raw: string | undefined,
  fields: readonly FieldDef[],
): Filter<RecordDoc> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidQuery("filter", "Must be a JSON object");
  }
  if (!isPlainRecord(parsed)) throw invalidQuery("filter", "Must be a JSON object");

  const allowed = new Set(fields.map((f) => f.key));
  const clause: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!allowed.has(key)) throw invalidQuery("filter", `Unknown field "${key}"`);
    if (!isFilterValue(value)) {
      throw invalidQuery("filter", `Field "${key}" must be a string, number, boolean or null`);
    }
    clause[`data.${key}`] = value;
  }
  return clause as Filter<RecordDoc>;
}

export type SortSpec = { field: string; mongoField: string; dir: 1 | -1; isDate: boolean };

const RESERVED_SORT_FIELDS: ReadonlySet<string> = new Set(["createdAt", "updatedAt"]);

/** AC4 — whitelisted to the entity's own fields plus `createdAt`/`updatedAt`. */
export function parseSortGrammar(
  raw: string | undefined,
  fields: readonly FieldDef[],
): SortSpec {
  if (!raw) return { field: "createdAt", mongoField: "createdAt", dir: -1, isDate: true };

  const dir: 1 | -1 = raw.startsWith("-") ? -1 : 1;
  const field = raw.startsWith("-") ? raw.slice(1) : raw;

  if (RESERVED_SORT_FIELDS.has(field)) {
    return { field, mongoField: field, dir, isDate: true };
  }
  const fieldDef = fields.find((f) => f.key === field);
  if (!fieldDef) throw invalidQuery("sort", `Unknown field "${field}"`);
  return { field, mongoField: `data.${field}`, dir, isDate: fieldDef.type === "date" };
}

/** `Date` round-trips as an ISO string; every other primitive round-trips through JSON. */
const encodeSortValue = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : JSON.stringify(value);

const decodeSortValue = (raw: string, isDate: boolean): unknown =>
  isDate ? new Date(raw) : (JSON.parse(raw) as unknown);

function sortValueOf(doc: WithId<RecordDoc>, sort: SortSpec): unknown {
  return sort.field === "createdAt" || sort.field === "updatedAt"
    ? doc[sort.field]
    : doc.data[sort.field];
}

/**
 * Keyset pagination: strictly past the last row's sort value, or tied on it
 * and past its `_id`. Stable under any whitelisted sort, unlike an offset.
 */
function cursorClause(cursor: string, sort: SortSpec): Filter<RecordDoc> {
  const decoded: CursorPayload = decodeCursor(cursor);
  if (decoded.at === undefined) throw invalidQuery("cursor", "Not a cursor issued by this API");
  const value = decodeSortValue(decoded.at, sort.isDate);
  const cmp = sort.dir === -1 ? "$lt" : "$gt";
  return {
    $or: [
      { [sort.mongoField]: { [cmp]: value } },
      { [sort.mongoField]: value, _id: { [cmp]: new ObjectId(decoded.id) } },
    ],
  } as Filter<RecordDoc>;
}

/** AC6 — drops fields the entity no longer has; never invents a value for a new one. */
function migrateData(
  data: Record<string, unknown>,
  fields: readonly FieldDef[],
): Record<string, unknown> {
  const validKeys = new Set(fields.map((f) => f.key));
  const migrated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (validKeys.has(key)) migrated[key] = value;
  }
  return migrated;
}

const needsMigration = (doc: Pick<RecordDoc, "schemaVersion">, entity: EntityView): boolean =>
  doc.schemaVersion !== entity.schemaVersion;

export type RecordDeps = {
  repo: Repository<RecordDoc>;
  getEntity: (ctx: Ctx, entityId: string) => Promise<EntityView>;
  consumeQuota: (ctx: Ctx, meter: Meter, amount?: number) => Promise<QuotaResult>;
};

const defaultRepo = createRepository<RecordDoc>("records");

function resolveDeps(overrides: Partial<RecordDeps> = {}): RecordDeps {
  return {
    repo: overrides.repo ?? defaultRepo,
    getEntity: overrides.getEntity ?? ((ctx, entityId) => getEntityDefault(ctx, entityId)),
    consumeQuota:
      overrides.consumeQuota ??
      ((ctx, meter, amount) => consumeQuotaDefault(ctx, meter, amount)),
  };
}

async function findRecordOrThrow(
  deps: RecordDeps,
  ctx: Ctx,
  entityId: string,
  recordId: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<WithId<RecordDoc>> {
  const filter: Filter<RecordDoc> = {
    _id: toObjectId(recordId),
    entityDefId: toObjectId(entityId),
    // A caller-supplied `deletedAt` overrides the repository's default
    // `{ deletedAt: null }` (src/server/repositories/base.ts) — AC5's admin path.
    ...(opts.includeDeleted ? { deletedAt: { $exists: true } } : {}),
  } as Filter<RecordDoc>;
  const doc = await deps.repo.findOne(ctx, filter);
  if (!doc) throw new AppError("NOT_FOUND", "Record not found");
  return doc;
}

/**
 * AC6 — migrates and persists on a real read, unless the row is soft-deleted
 * (an admin fetch of a deleted row should not resurrect a write).
 */
async function withMigration(
  deps: RecordDeps,
  ctx: Ctx,
  entity: EntityView,
  doc: WithId<RecordDoc>,
): Promise<WithId<RecordDoc>> {
  if (!needsMigration(doc, entity)) return doc;
  const data = migrateData(doc.data, entity.fields);
  if (doc.deletedAt) return { ...doc, data, schemaVersion: entity.schemaVersion };
  const updated = await deps.repo.updateOne(
    ctx,
    { _id: doc._id, entityDefId: doc.entityDefId } as Filter<RecordDoc>,
    { $set: { data, schemaVersion: entity.schemaVersion } },
  );
  return updated ?? { ...doc, data, schemaVersion: entity.schemaVersion };
}

/** AC1, AC7 — validated against the compiled schema, quota reserved before the write. */
export async function createRecord(
  ctx: Ctx,
  entityId: string,
  input: unknown,
  overrides: Partial<RecordDeps> = {},
): Promise<RecordView> {
  const deps = resolveDeps(overrides);
  const entity = await deps.getEntity(ctx, entityId);
  const compiled = getCompiledSchema(
    ctx.tenantId,
    entityId,
    entity.schemaVersion,
    entity.fields,
  );
  const data = parse(compiled, input, "body") as Record<string, unknown>;

  await deps.consumeQuota(ctx, "records");

  const doc = await deps.repo.insertOne(ctx, {
    entityDefId: toObjectId(entityId),
    schemaVersion: entity.schemaVersion,
    data,
    deletedAt: null,
  });
  return toView(doc, entityId);
}

/** AC2, AC3, AC4 — cursor-paginated, filter- and sort-whitelisted listing. */
export async function listRecords(
  ctx: Ctx,
  entityId: string,
  query: { cursor?: string; limit?: unknown; filter?: string; sort?: string },
  overrides: Partial<RecordDeps> = {},
): Promise<{
  items: RecordView[];
  meta: { limit: number; hasMore: boolean; cursor: string | null };
}> {
  const deps = resolveDeps(overrides);
  const entity = await deps.getEntity(ctx, entityId);
  const filterClause = parseFilterGrammar(query.filter, entity.fields);
  const sort = parseSortGrammar(query.sort, entity.fields);
  const limit = clampLimit(query.limit);

  const baseFilter = {
    entityDefId: toObjectId(entityId),
    ...filterClause,
  } as Filter<RecordDoc>;
  const filter = query.cursor
    ? ({ $and: [baseFilter, cursorClause(query.cursor, sort)] } as Filter<RecordDoc>)
    : baseFilter;

  const options: FindOptions = {
    sort: { [sort.mongoField]: sort.dir, _id: sort.dir },
    limit: limit + 1,
  };
  const rows = await deps.repo.find(ctx, filter, options);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const cursor =
    hasMore && last
      ? encodeCursor({
          id: last._id.toHexString(),
          at: encodeSortValue(sortValueOf(last, sort)),
        })
      : null;

  const items = page.map((doc) => {
    const migrated = needsMigration(doc, entity)
      ? {
          ...doc,
          data: migrateData(doc.data, entity.fields),
          schemaVersion: entity.schemaVersion,
        }
      : doc;
    return toView(migrated, entityId);
  });

  return { items, meta: { limit, hasMore, cursor } };
}

/** AC6, AC8 — 404 outside the tenant or entity; migrates lazily on the way out. */
export async function getRecord(
  ctx: Ctx,
  entityId: string,
  recordId: string,
  opts: { includeDeleted?: boolean } = {},
  overrides: Partial<RecordDeps> = {},
): Promise<RecordView> {
  const deps = resolveDeps(overrides);
  const entity = await deps.getEntity(ctx, entityId);
  const doc = await findRecordOrThrow(deps, ctx, entityId, recordId, opts);
  const migrated = await withMigration(deps, ctx, entity, doc);
  return toView(migrated, entityId);
}

function validatePartialUpdate(
  input: unknown,
  fields: readonly FieldDef[],
): Record<string, unknown> {
  if (!isPlainRecord(input)) {
    throw new AppError("VALIDATION_FAILED", "Invalid request body", {
      source: "body",
      fields: { "(body)": "Expected a JSON object" },
    });
  }
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const patch: Record<string, unknown> = {};
  const fieldErrors: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const fieldDef = byKey.get(key);
    if (!fieldDef) {
      fieldErrors[key] = "Unknown field";
      continue;
    }
    const result = compileFieldSchema(fieldDef).safeParse(value);
    if (!result.success) {
      fieldErrors[key] = result.error.issues[0]?.message ?? "Invalid value";
      continue;
    }
    patch[key] = result.data;
  }
  if (Object.keys(fieldErrors).length) {
    throw new AppError("VALIDATION_FAILED", "Invalid request body", {
      source: "body",
      fields: fieldErrors,
    });
  }
  return patch;
}

/** Partial update: unknown keys rejected, merged result re-validated whole. */
export async function updateRecord(
  ctx: Ctx,
  entityId: string,
  recordId: string,
  input: unknown,
  overrides: Partial<RecordDeps> = {},
): Promise<RecordView> {
  const deps = resolveDeps(overrides);
  const entity = await deps.getEntity(ctx, entityId);
  const existing = await findRecordOrThrow(deps, ctx, entityId, recordId);
  const patch = validatePartialUpdate(input, entity.fields);

  const migratedExisting = migrateData(existing.data, entity.fields);
  const merged = { ...migratedExisting, ...patch };
  const compiled = getCompiledSchema(
    ctx.tenantId,
    entityId,
    entity.schemaVersion,
    entity.fields,
  );
  const data = parse(compiled, merged, "body") as Record<string, unknown>;

  const updated = await deps.repo.updateOne(
    ctx,
    { _id: existing._id, entityDefId: existing.entityDefId } as Filter<RecordDoc>,
    { $set: { data, schemaVersion: entity.schemaVersion } },
  );
  if (!updated) throw new AppError("NOT_FOUND", "Record not found");
  return toView(updated, entityId);
}

/** AC5 — soft delete only; still reachable by id via `getRecord(..., { includeDeleted: true })`. */
export async function deleteRecord(
  ctx: Ctx,
  entityId: string,
  recordId: string,
  overrides: Partial<RecordDeps> = {},
): Promise<void> {
  const deps = resolveDeps(overrides);
  await deps.getEntity(ctx, entityId);
  const existing = await findRecordOrThrow(deps, ctx, entityId, recordId);
  const deleted = await deps.repo.softDelete(ctx, existing._id);
  if (!deleted) throw new AppError("NOT_FOUND", "Record not found");
}
