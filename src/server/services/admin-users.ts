/**
 * Cross-tenant user reads for the admin console's Users screen.
 *
 * Same three rules as admin-tenants.ts, for the same reasons:
 *
 *  1. `users` is a global collection and is read directly, never through
 *     `createRepository`. `assertPlatformAdmin` on the route is the only thing
 *     protecting this read.
 *  2. Every field is an explicit allow-list (`toAdminUser`). A user document
 *     carries a `passwordHash`; it is not stripped here, it is simply never
 *     named, and admin-users.test.ts asserts that a hash on the document cannot
 *     reach the output.
 *  3. `q` is escaped to a literal before it becomes a `$regex`.
 *
 * Email *is* returned, unlike the masked recipient in the activity log. This
 * screen exists so the platform owner can find a person who wrote in to
 * support; a masked address would defeat it. It is a response body behind the
 * platform-admin gate, not a log line, and it is never written to one.
 *
 * Membership tenant names are resolved in a second query over the page's own
 * tenant ids — never a `$lookup` across the whole collection.
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

export type AdminUserDoc = {
  _id: ObjectId;
  email?: string;
  name?: string | null;
  emailVerifiedAt?: Date | null;
  memberships?: { tenantId: ObjectId; roles?: string[] }[];
  isPlatformAdmin?: unknown;
  createdAt?: Date;
};

export type AdminUserMembership = Readonly<{
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  roles: readonly string[];
}>;

export type AdminUser = Readonly<{
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  isPlatformAdmin: boolean;
  createdAt: string | null;
  memberships: readonly AdminUserMembership[];
}>;

export type TenantLabel = { name: string | null; slug: string | null };

export type AdminUserStore = {
  listUsers(filter: Filter<AdminUserDoc>, limit: number): Promise<AdminUserDoc[]>;
  tenantLabels(ids: ObjectId[]): Promise<Map<string, TenantLabel>>;
};

export const adminUserListQuerySchema = z.object({
  q: z.string().max(MAX_SEARCH_LENGTH).optional(),
  tenantId: z.string().regex(objectIdHex, "Expected a 24-character id").optional(),
  role: z.enum(["owner", "admin", "member"]).optional(),
  verified: z.enum(["true", "false"]).optional(),
  platformAdmin: z.enum(["true", "false"]).optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
});

export type AdminUserListQuery = z.infer<typeof adminUserListQuerySchema>;

const KNOWN_ROLES = new Set(["owner", "admin", "member"]);

/** Every key written out by hand — see the header. */
export function toAdminUser(doc: AdminUserDoc, labels: Map<string, TenantLabel>): AdminUser {
  const memberships = (doc.memberships ?? []).flatMap((m) => {
    const tenantId = hexOf(m.tenantId);
    if (!tenantId) return [];
    const label = labels.get(tenantId);
    return [
      Object.freeze({
        tenantId,
        tenantName: label?.name ?? null,
        tenantSlug: label?.slug ?? null,
        roles: Object.freeze((m.roles ?? []).filter((role) => KNOWN_ROLES.has(role))),
      }),
    ];
  });
  return Object.freeze({
    id: doc._id.toHexString(),
    email: isString(doc.email) ? doc.email : "",
    name: isString(doc.name) ? doc.name : null,
    emailVerified: doc.emailVerifiedAt instanceof Date,
    isPlatformAdmin: doc.isPlatformAdmin === true,
    createdAt: iso(doc.createdAt),
    memberships: Object.freeze(memberships),
  });
}

/** Built here, from validated input only — a client filter never reaches Mongo. */
export function buildUserFilter(query: AdminUserListQuery): Filter<AdminUserDoc> {
  const filter: Filter<AdminUserDoc> = {};

  if (query.tenantId || query.role) {
    const match: Record<string, unknown> = {};
    if (query.tenantId) match.tenantId = new ObjectId(query.tenantId);
    if (query.role) match.roles = query.role;
    filter.memberships = { $elemMatch: match } as Filter<AdminUserDoc>["memberships"];
  }
  if (query.verified === "true") filter.emailVerifiedAt = { $ne: null };
  if (query.verified === "false") filter.emailVerifiedAt = null;
  if (query.platformAdmin === "true") filter.isPlatformAdmin = true;
  if (query.platformAdmin === "false") filter.isPlatformAdmin = { $ne: true };

  if (query.cursor) {
    filter._id = { $lt: new ObjectId(decodeCursor(query.cursor).id) };
  }

  const q = searchTerm(query.q);
  if (q) {
    const $regex = escapeRegex(q);
    filter.$or = [
      { email: { $regex, $options: "i" } },
      { name: { $regex, $options: "i" } },
    ] as Filter<AdminUserDoc>["$or"];
  }
  return filter;
}

/** Tenant name/slug for a set of ids — shared by users, entities and audit reads. */
export async function mongoTenantLabels(ids: ObjectId[]): Promise<Map<string, TenantLabel>> {
  const labels = new Map<string, TenantLabel>();
  if (ids.length === 0) return labels;
  const db = await getDb();
  const docs = await db
    .collection<{ _id: ObjectId; name?: string; slug?: string }>("tenants")
    .find({ _id: { $in: ids } }, { projection: { name: 1, slug: 1 } })
    .toArray();
  for (const doc of docs) {
    labels.set(doc._id.toHexString(), {
      name: isString(doc.name) ? doc.name : null,
      slug: isString(doc.slug) ? doc.slug : null,
    });
  }
  return labels;
}

/** De-duplicated ObjectIds, so a label query never asks for the same tenant twice. */
export function uniqueIds(ids: (ObjectId | null | undefined)[]): ObjectId[] {
  const seen = new Map<string, ObjectId>();
  for (const id of ids) if (id instanceof ObjectId) seen.set(id.toHexString(), id);
  return [...seen.values()];
}

export function mongoAdminUserStore(): AdminUserStore {
  return {
    async listUsers(filter, limit) {
      const db = await getDb();
      return db
        .collection<AdminUserDoc>("users")
        .find(filter, {
          // A projection as well as the allow-list: the hash never leaves Mongo.
          projection: {
            email: 1,
            name: 1,
            emailVerifiedAt: 1,
            memberships: 1,
            isPlatformAdmin: 1,
            createdAt: 1,
          },
        })
        .sort({ _id: -1 })
        .limit(limit)
        .toArray();
    },
    tenantLabels: mongoTenantLabels,
  };
}

export async function listAdminUsers(
  query: unknown,
  overrides: Partial<{ store: AdminUserStore }> = {},
): Promise<{ items: AdminUser[]; meta: PageMeta }> {
  const parsed = parseOrThrow(adminUserListQuerySchema, query);
  const store = overrides.store ?? mongoAdminUserStore();
  const limit = clampLimit(parsed.limit);
  const rows = await store.listUsers(buildUserFilter(parsed), limit + 1);
  const paged = page(rows, limit, (row) => ({ id: row._id.toHexString() }));
  const labels = await store.tenantLabels(
    uniqueIds(paged.items.flatMap((row) => (row.memberships ?? []).map((m) => m.tenantId))),
  );
  return { items: paged.items.map((row) => toAdminUser(row, labels)), meta: paged.meta };
}
