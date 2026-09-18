/**
 * The platform-admin audit log (GRAFT-27.1 AC6/AC7).
 *
 * Every admin action taken from here on appends exactly one row here, and the
 * collection has three properties that are the whole reason it exists:
 *
 *  - **Append-only.** The store below exposes `append` and nothing else. There
 *    is no update path and no delete path, not because they are guarded but
 *    because they are not written. An audit log you can edit is a log you
 *    cannot cite.
 *  - **Actions, not attempts.** Only a *successful* pass through
 *    `assertPlatformAdmin` writes a row (see src/server/auth/platform-admin.ts).
 *    A refusal is a plain `admin.denied` log line instead. If denials landed
 *    here, anyone who could reach the route could grow the collection at will,
 *    which turns the audit trail into an unauthenticated write surface.
 *  - **No PII.** The row is built from `ADMIN_AUDIT_FIELDS` and nothing else,
 *    so a caller who passes more — an email, a request body, a name — does not
 *    widen it (.github/agent-policy.yml `security_checklist`: "No PII in logs;
 *    requestId + tenantId + userId only"). `actorUserId` identifies the actor;
 *    resolving that to a person is a deliberate second step, taken by whoever
 *    is reading the log.
 *
 * This is a *global* collection, not a tenant-scoped one, so it deliberately
 * does not go through the ctx-injecting repository layer
 * (src/server/repositories/base.ts) — same argument as src/server/auth/stores.ts.
 * `targetTenantId` records which tenant an action was *about*; it is never a
 * filter, and nothing here reads a tenant-scoped business collection.
 */
import { ObjectId } from "mongodb";
import { getDb } from "@/server/db/mongo";

export const ADMIN_AUDIT_COLLECTION = "admin_audit_log";

/** The row's entire shape. Anything not on this list does not get written. */
export const ADMIN_AUDIT_FIELDS = [
  "actorUserId",
  "action",
  "targetTenantId",
  "requestId",
  "at",
] as const;

export type AdminAuditEntry = {
  /** The platform admin who acted. An id, never a name or an address. */
  actorUserId: string;
  /** A stable dotted verb, e.g. `admin.session.read`. Never free-form prose. */
  action: string;
  /** The tenant the action was about, or null when it was about none. */
  targetTenantId: string | null;
  requestId: string;
  at: Date;
};

/** What a caller supplies; `at` is stamped by the writer, not by the caller. */
export type AdminAuditInput = {
  actorUserId: string;
  action: string;
  targetTenantId?: string | null;
  requestId: string;
};

export type AdminAuditStore = {
  append(entry: AdminAuditEntry): Promise<void>;
};

export type AdminAuditDeps = {
  audit: AdminAuditStore;
  now: () => Date;
};

/**
 * Ids are stored as ObjectIds, as everywhere else in the schema, so an audit
 * row joins to `users` and `tenants` without a cast. An id that is not valid
 * hex cannot reach here from a route — `ctx.userId` is validated by
 * `createContext` — so an invalid one is a bug, and throwing is the right
 * failure: a row we could not attribute is worse than no row.
 */
export function mongoAdminAuditStore(): AdminAuditStore {
  return {
    async append(entry) {
      const db = await getDb();
      await db.collection(ADMIN_AUDIT_COLLECTION).insertOne({
        _id: new ObjectId(),
        actorUserId: new ObjectId(entry.actorUserId),
        action: entry.action,
        targetTenantId: entry.targetTenantId ? new ObjectId(entry.targetTenantId) : null,
        requestId: entry.requestId,
        at: entry.at,
      });
    },
  };
}

let defaultStore: AdminAuditStore | undefined;
const store = () => (defaultStore ??= mongoAdminAuditStore());

/**
 * Append one row for one action that actually happened.
 *
 * The document is assembled field by field rather than spread from `input`;
 * that is what makes "no PII in the audit log" a property of this function
 * instead of a rule every future caller has to remember.
 */
export async function recordAdminAction(
  input: AdminAuditInput,
  deps: Partial<AdminAuditDeps> = {},
): Promise<AdminAuditEntry> {
  const entry: AdminAuditEntry = {
    actorUserId: input.actorUserId,
    action: input.action,
    targetTenantId: input.targetTenantId ?? null,
    requestId: input.requestId,
    at: (deps.now ?? (() => new Date()))(),
  };
  await (deps.audit ?? store()).append(entry);
  return entry;
}
