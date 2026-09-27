/**
 * The read side of `admin_audit_log`, for the admin console's Audit screen.
 *
 * Deliberately a separate module from admin-audit.ts. That file's header makes
 * a promise — "the store exposes `append` and nothing else" — and a list
 * method added beside `append` would quietly break it. Reading is a different
 * capability with a different caller, so it lives here, and it too has no
 * update or delete path.
 *
 * The audit row stores ids only (no PII in the log). Resolving `actorUserId`
 * to an email and `targetTenantId` to a name is "a deliberate second step,
 * taken by whoever is reading the log" (admin-audit.ts) — this is that step,
 * behind the same platform-admin gate as every other admin read.
 */
import { ObjectId, type Filter } from "mongodb";
import { z } from "zod";
import { getDb } from "@/server/db/mongo";
import { clampLimit, decodeCursor, page, type PageMeta } from "@/server/http/pagination";
import { ADMIN_AUDIT_COLLECTION } from "./admin-audit";
import { escapeRegex, hexOf, iso, isString, objectIdHex, parseOrThrow } from "./admin-common";
import { mongoTenantLabels, uniqueIds, type TenantLabel } from "./admin-users";

export type AdminAuditDoc = {
  _id: ObjectId;
  actorUserId: ObjectId;
  action: string;
  targetTenantId: ObjectId | null;
  requestId?: string;
  at: Date;
  fromTier?: unknown;
  toTier?: unknown;
  reason?: unknown;
  changed?: unknown;
  ok?: unknown;
};

export type AdminAuditRow = Readonly<{
  id: string;
  action: string;
  actorUserId: string | null;
  actorEmail: string | null;
  targetTenantId: string | null;
  targetTenantName: string | null;
  requestId: string | null;
  at: string | null;
  details: Readonly<{
    fromTier?: string;
    toTier?: string;
    reason?: string;
    changed?: boolean;
    ok?: boolean;
  }>;
}>;

export type AdminAuditReadStore = {
  listAudit(filter: Filter<AdminAuditDoc>, limit: number): Promise<AdminAuditDoc[]>;
  userEmails(ids: ObjectId[]): Promise<Map<string, string>>;
  tenantLabels(ids: ObjectId[]): Promise<Map<string, TenantLabel>>;
};

const isoDate = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "Expected an ISO date");

export const adminAuditListQuerySchema = z.object({
  // Audit actions are stable dotted verbs (`admin.tenants.list`); the filter is
  // a prefix, matched literally, so `admin.tenant` finds reads and writes alike.
  action: z
    .string()
    .max(60)
    .regex(/^[a-z][a-z0-9_.]*$/, "Expected a dotted action prefix")
    .optional(),
  tenantId: z.string().regex(objectIdHex, "Expected a 24-character id").optional(),
  actorUserId: z.string().regex(objectIdHex, "Expected a 24-character id").optional(),
  // Reads vastly outnumber writes; `writes` hides the noise of every page view.
  kind: z.enum(["all", "writes"]).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
});

export type AdminAuditListQuery = z.infer<typeof adminAuditListQuerySchema>;

export function buildAuditFilter(query: AdminAuditListQuery): Filter<AdminAuditDoc> {
  const filter: Filter<AdminAuditDoc> = {};
  if (query.action) filter.action = { $regex: `^${escapeRegex(query.action)}` };
  if (query.tenantId) filter.targetTenantId = new ObjectId(query.tenantId);
  if (query.actorUserId) filter.actorUserId = new ObjectId(query.actorUserId);
  // A write is any row that recorded an outcome — reads never carry one.
  if (query.kind === "writes") filter.ok = { $exists: true };
  if (query.from || query.to) {
    const at: { $gte?: Date; $lte?: Date } = {};
    if (query.from) at.$gte = new Date(query.from);
    if (query.to) at.$lte = new Date(query.to);
    filter.at = at;
  }
  if (query.cursor) filter._id = { $lt: new ObjectId(decodeCursor(query.cursor).id) };
  return filter;
}

export function toAdminAuditRow(
  doc: AdminAuditDoc,
  emails: Map<string, string>,
  labels: Map<string, TenantLabel>,
): AdminAuditRow {
  const actorUserId = hexOf(doc.actorUserId);
  const targetTenantId = hexOf(doc.targetTenantId);
  const details: Record<string, string | boolean> = {};
  if (isString(doc.fromTier)) details.fromTier = doc.fromTier;
  if (isString(doc.toTier)) details.toTier = doc.toTier;
  if (isString(doc.reason)) details.reason = doc.reason;
  if (typeof doc.changed === "boolean") details.changed = doc.changed;
  if (typeof doc.ok === "boolean") details.ok = doc.ok;
  return Object.freeze({
    id: doc._id.toHexString(),
    action: isString(doc.action) ? doc.action : "",
    actorUserId,
    actorEmail: actorUserId ? (emails.get(actorUserId) ?? null) : null,
    targetTenantId,
    targetTenantName: targetTenantId ? (labels.get(targetTenantId)?.name ?? null) : null,
    requestId: isString(doc.requestId) ? doc.requestId : null,
    at: iso(doc.at),
    details: Object.freeze(details),
  });
}

export function mongoAdminAuditReadStore(): AdminAuditReadStore {
  return {
    async listAudit(filter, limit) {
      const db = await getDb();
      return db
        .collection<AdminAuditDoc>(ADMIN_AUDIT_COLLECTION)
        .find(filter)
        .sort({ _id: -1 })
        .limit(limit)
        .toArray();
    },
    async userEmails(ids) {
      const emails = new Map<string, string>();
      if (ids.length === 0) return emails;
      const db = await getDb();
      const docs = await db
        .collection<{ _id: ObjectId; email?: string }>("users")
        .find({ _id: { $in: ids } }, { projection: { email: 1 } })
        .toArray();
      for (const doc of docs)
        if (isString(doc.email)) emails.set(doc._id.toHexString(), doc.email);
      return emails;
    },
    tenantLabels: mongoTenantLabels,
  };
}

export async function listAdminAudit(
  query: unknown,
  overrides: Partial<{ store: AdminAuditReadStore }> = {},
): Promise<{ items: AdminAuditRow[]; meta: PageMeta }> {
  const parsed = parseOrThrow(adminAuditListQuerySchema, query);
  const store = overrides.store ?? mongoAdminAuditReadStore();
  const limit = clampLimit(parsed.limit);
  const rows = await store.listAudit(buildAuditFilter(parsed), limit + 1);
  const paged = page(rows, limit, (row) => ({ id: row._id.toHexString() }));
  const [emails, labels] = await Promise.all([
    store.userEmails(uniqueIds(paged.items.map((row) => row.actorUserId))),
    store.tenantLabels(uniqueIds(paged.items.map((row) => row.targetTenantId))),
  ]);
  return {
    items: paged.items.map((row) => toAdminAuditRow(row, emails, labels)),
    meta: paged.meta,
  };
}
