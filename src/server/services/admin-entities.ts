/**
 * Cross-tenant entity-definition reads for the admin console's Entities
 * screen: which shapes each tenant has built, how big they are, and how many
 * records fill them.
 *
 * This reports *schema metadata* only — a definition's key, name and field
 * list (key, label, type, required). It never reads a record's `data`: what a
 * tenant stores in its records is its business, and the console's job is
 * "how is the product being used", which counts answer. Same rules as
 * admin-tenants.ts otherwise: direct reads, no `createRepository`, no
 * `ctx.tenantId` scope, explicit allow-list, escaped `q`.
 */
import { ObjectId, type Filter } from "mongodb";
import { z } from "zod";
import { getDb } from "@/server/db/mongo";
import { clampLimit, decodeCursor, page, type PageMeta } from "@/server/http/pagination";
import {
  escapeRegex,
  hexOf,
  iso,
  isString,
  MAX_SEARCH_LENGTH,
  objectIdHex,
  parseOrThrow,
  searchTerm,
} from "./admin-common";
import { mongoTenantLabels, uniqueIds, type TenantLabel } from "./admin-users";

export type AdminEntityDoc = {
  _id: ObjectId;
  tenantId: ObjectId;
  key?: string;
  name?: string;
  fields?: { key?: unknown; label?: unknown; type?: unknown; required?: unknown }[];
  schemaVersion?: number;
  deletedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
};

export type AdminEntityField = Readonly<{
  key: string;
  label: string;
  type: string;
  required: boolean;
}>;

export type AdminEntity = Readonly<{
  id: string;
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  key: string;
  name: string;
  fields: readonly AdminEntityField[];
  schemaVersion: number;
  recordCount: number;
  deleted: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}>;

export type AdminEntityStore = {
  listEntities(filter: Filter<AdminEntityDoc>, limit: number): Promise<AdminEntityDoc[]>;
  recordCounts(entityIds: ObjectId[]): Promise<Map<string, number>>;
  tenantLabels(ids: ObjectId[]): Promise<Map<string, TenantLabel>>;
};

export const adminEntityListQuerySchema = z.object({
  q: z.string().max(MAX_SEARCH_LENGTH).optional(),
  tenantId: z.string().regex(objectIdHex, "Expected a 24-character id").optional(),
  deleted: z.enum(["include", "only", "exclude"]).optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
});

export type AdminEntityListQuery = z.infer<typeof adminEntityListQuerySchema>;

const toField = (raw: NonNullable<AdminEntityDoc["fields"]>[number]): AdminEntityField =>
  Object.freeze({
    key: isString(raw.key) ? raw.key : "",
    label: isString(raw.label) ? raw.label : "",
    type: isString(raw.type) ? raw.type : "unknown",
    required: raw.required === true,
  });

export function toAdminEntity(
  doc: AdminEntityDoc,
  counts: Map<string, number>,
  labels: Map<string, TenantLabel>,
): AdminEntity {
  const id = doc._id.toHexString();
  const tenantId = hexOf(doc.tenantId) ?? "";
  const label = labels.get(tenantId);
  return Object.freeze({
    id,
    tenantId,
    tenantName: label?.name ?? null,
    tenantSlug: label?.slug ?? null,
    key: isString(doc.key) ? doc.key : "",
    name: isString(doc.name) ? doc.name : "",
    fields: Object.freeze((Array.isArray(doc.fields) ? doc.fields : []).map(toField)),
    schemaVersion: typeof doc.schemaVersion === "number" ? doc.schemaVersion : 1,
    recordCount: counts.get(id) ?? 0,
    deleted: doc.deletedAt instanceof Date,
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
  });
}

export function buildEntityFilter(query: AdminEntityListQuery): Filter<AdminEntityDoc> {
  const filter: Filter<AdminEntityDoc> = {};
  if (query.tenantId) filter.tenantId = new ObjectId(query.tenantId);
  // Default is live definitions only — a soft-deleted shape is history, not usage.
  const deleted = query.deleted ?? "exclude";
  if (deleted === "exclude") filter.deletedAt = null;
  if (deleted === "only") filter.deletedAt = { $ne: null };

  if (query.cursor) filter._id = { $lt: new ObjectId(decodeCursor(query.cursor).id) };

  const q = searchTerm(query.q);
  if (q) {
    const $regex = escapeRegex(q);
    filter.$or = [
      { name: { $regex, $options: "i" } },
      { key: { $regex, $options: "i" } },
    ] as Filter<AdminEntityDoc>["$or"];
  }
  return filter;
}

export function mongoAdminEntityStore(): AdminEntityStore {
  return {
    async listEntities(filter, limit) {
      const db = await getDb();
      return db
        .collection<AdminEntityDoc>("entity_defs")
        .find(filter)
        .sort({ _id: -1 })
        .limit(limit)
        .toArray();
    },
    async recordCounts(entityIds) {
      const counts = new Map<string, number>();
      if (entityIds.length === 0) return counts;
      const db = await getDb();
      const rows = await db
        .collection("records")
        .aggregate<{ _id: ObjectId; count: number }>([
          { $match: { entityDefId: { $in: entityIds }, deletedAt: null } },
          { $group: { _id: "$entityDefId", count: { $sum: 1 } } },
        ])
        .toArray();
      for (const row of rows) counts.set(row._id.toHexString(), row.count);
      return counts;
    },
    tenantLabels: mongoTenantLabels,
  };
}

export async function listAdminEntities(
  query: unknown,
  overrides: Partial<{ store: AdminEntityStore }> = {},
): Promise<{ items: AdminEntity[]; meta: PageMeta }> {
  const parsed = parseOrThrow(adminEntityListQuerySchema, query);
  const store = overrides.store ?? mongoAdminEntityStore();
  const limit = clampLimit(parsed.limit);
  const rows = await store.listEntities(buildEntityFilter(parsed), limit + 1);
  const paged = page(rows, limit, (row) => ({ id: row._id.toHexString() }));
  const [counts, labels] = await Promise.all([
    store.recordCounts(paged.items.map((row) => row._id)),
    store.tenantLabels(uniqueIds(paged.items.map((row) => row.tenantId))),
  ]);
  return {
    items: paged.items.map((row) => toAdminEntity(row, counts, labels)),
    meta: paged.meta,
  };
}
