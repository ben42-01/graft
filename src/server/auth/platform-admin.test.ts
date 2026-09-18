import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GRAFT-27.1 — the platform-admin gate.
 *
 * The four invariants this file exists to pin, because each one is a thing a
 * later change could quietly undo:
 *
 *  - a refusal is `404 NOT_FOUND`, never `403` (AC2). The admin surface does
 *    not confirm its own existence, so the refusal has to be indistinguishable
 *    from an unrouted path — asserted here against the real catch-all route.
 *  - the tenant role `admin` grants nothing (AC3). Two words, one of them
 *    load-bearing; this is the collision the contract calls out by name.
 *  - the flag is re-read from the database on every call (AC5). A grant on a
 *    15-minute token is a grant you cannot revoke for 15 minutes.
 *  - a denial writes no audit row (AC7), and the admin read touches no
 *    tenant-scoped collection at all (AC10).
 *
 * The AC10 test drives the real route through a Mongo double whose `collection`
 * throws for anything outside `users` and `admin_audit_log`, and a
 * `createRepository` that throws unconditionally. That is stricter than
 * asserting a specific call was absent: any tenant-scoped read, by any route,
 * through any layer, fails the test.
 */

const ALLOWED_COLLECTIONS = new Set(["users", "admin_audit_log"]);

const userDoc: Record<string, unknown> = {};
const auditRows: Record<string, unknown>[] = [];
const collectionsTouched: string[] = [];

/**
 * The double records *queries*, not handles. `mongoAccountStore` builds a
 * handle for `tenants` and `email_verification_tokens` up front whether or not
 * it uses them, and holding a handle reads nothing — asserting on construction
 * would fail this test for a query that never happens. Every actual operation,
 * on the other hand, goes through one of the methods below, so the guard here
 * is what AC10 actually claims: nothing tenant-scoped is *read*.
 */
vi.mock("@/server/db/mongo", () => ({
  getDb: async () => ({
    collection(name: string) {
      const query = <T>(result: () => T) => {
        collectionsTouched.push(name);
        if (!ALLOWED_COLLECTIONS.has(name)) {
          throw new Error(`AC10 — the admin surface queried tenant-scoped '${name}'`);
        }
        return result();
      };
      return {
        findOne: async () => query(() => (Object.keys(userDoc).length ? userDoc : null)),
        find: () => query(() => ({ toArray: async () => [] })),
        countDocuments: async () => query(() => 0),
        aggregate: () => query(() => ({ toArray: async () => [] })),
        updateOne: async () => query(() => ({ matchedCount: 0, modifiedCount: 0 })),
        findOneAndUpdate: async () => query(() => null),
        deleteOne: async () => query(() => ({ deletedCount: 0 })),
        insertOne: async (doc: Record<string, unknown>) =>
          query(() => {
            auditRows.push(doc);
            return { insertedId: "audit" };
          }),
      };
    },
  }),
}));

vi.mock("@/server/repositories/base", () => ({
  createRepository: () => {
    throw new Error("AC10 — the admin surface went through the tenant repository layer");
  },
}));

vi.mock("@/server/rate-limit/enforce", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/rate-limit/enforce")>()),
  enforceRateLimit: async () => ({ headers: {} }),
}));

vi.mock("@/server/auth/session", () => ({
  contextFromRequest: async (_request: Request, options: { requestId?: string } = {}) => ({
    requestId: options.requestId ?? "req-test",
    tenantId: "000000000000000000000002",
    userId: "000000000000000000000050",
    roles: ["owner", "admin"],
    tier: "premium",
  }),
}));

import { ObjectId } from "mongodb";
import { GET as adminSession } from "@/app/api/v1/admin/session/route";
import { GET as unrouted } from "@/app/api/v1/[...path]/route";
import { createContext, type Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import type { AdminAuditEntry } from "@/server/services/admin-audit";
import type { UserRecord } from "./accounts-store";
import { assertPlatformAdmin } from "./platform-admin";

const ADMIN_ID = "000000000000000000000050";
const TENANT_ID = "000000000000000000000002";

const ctxWith = (roles: Ctx["roles"] = ["member"]): Ctx =>
  createContext({
    requestId: "req-test",
    tenantId: TENANT_ID,
    userId: ADMIN_ID,
    roles,
    tier: "premium",
  });

const userWith = (flag: unknown, roles: string[] = ["member"]): UserRecord =>
  ({
    id: ADMIN_ID,
    email: "platform-admin@qa.test",
    name: "QA Platform Admin",
    passwordHash: null,
    emailVerifiedAt: new Date(),
    memberships: [{ tenantId: TENANT_ID, roles }],
    isPlatformAdmin: flag,
  }) as unknown as UserRecord;

/** Deps for a direct call: no Mongo, so the store's own behaviour is not in play. */
function deps(user: UserRecord | null) {
  const appended: AdminAuditEntry[] = [];
  const warnings: { message: string; fields?: Record<string, unknown> }[] = [];
  return {
    appended,
    warnings,
    options: {
      request: new Request("http://localhost/api/v1/admin/session"),
      action: "admin.session.read",
      log: {
        debug: () => {},
        info: () => {},
        warn: (message: string, fields?: Record<string, unknown>) =>
          void warnings.push({ message, fields }),
        error: () => {},
        child: () => {
          throw new Error("unused");
        },
      },
      deps: {
        accounts: { findUserById: async () => user },
        audit: { append: async (entry: AdminAuditEntry) => void appended.push(entry) },
      },
    },
  };
}

beforeEach(() => {
  for (const key of Object.keys(userDoc)) delete userDoc[key];
  auditRows.length = 0;
  collectionsTouched.length = 0;
});

afterEach(() => vi.restoreAllMocks());

describe("assertPlatformAdmin", () => {
  it("returns the actor for a user whose stored flag is exactly true", async () => {
    const { options, appended } = deps(userWith(true));
    const actor = await assertPlatformAdmin(ctxWith(), options);

    expect(actor).toEqual({
      userId: ADMIN_ID,
      email: "platform-admin@qa.test",
      isPlatformAdmin: true,
    });
    // AC6 — the success, and only the success, is recorded.
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ actorUserId: ADMIN_ID, action: "admin.session.read" });
  });

  /**
   * AC2 — the values a sloppy grant script or a hand-edited document would
   * actually produce. Every one of them is truthy in JavaScript, and every one
   * of them must be refused: the check is `=== true`, not `if (flag)`.
   */
  it.each([
    ["absent", undefined],
    ['the string "true"', "true"],
    ["the number 1", 1],
    ["null", null],
    ['the string "false"', "false"],
    ["an empty object", {}],
    ["boolean false", false],
  ])("AC2 — refuses a flag that is %s with 404 NOT_FOUND", async (_label, flag) => {
    const { options, appended, warnings } = deps(userWith(flag));
    const error = await assertPlatformAdmin(ctxWith(), options).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("NOT_FOUND");
    expect((error as AppError).status).toBe(404);
    // AC7 — a refusal is a log line, never a row.
    expect(appended).toHaveLength(0);
    expect(warnings).toEqual([
      { message: "admin.denied", fields: { requestId: "req-test", userId: ADMIN_ID } },
    ]);
  });

  it("AC2 — never answers 403, which is what a tenant refusal looks like", async () => {
    const { options } = deps(userWith(undefined));
    const error = (await assertPlatformAdmin(ctxWith(), options).catch(
      (e: unknown) => e,
    )) as AppError;
    expect(error.status).not.toBe(403);
    expect(error.code).not.toBe("FORBIDDEN");
  });

  /**
   * AC3 — the collision risk named in the contract. `admin` is a *tenant* role;
   * it is not, and must never become, a synonym for the platform flag.
   */
  it.each([["owner"], ["admin"], ["owner", "admin"]])(
    "AC3 — the tenant role(s) %s grant nothing here",
    async (...roles) => {
      const { options, appended } = deps(userWith(undefined, roles));
      const error = (await assertPlatformAdmin(ctxWith(roles as Ctx["roles"]), options).catch(
        (e: unknown) => e,
      )) as AppError;

      expect(error.code).toBe("NOT_FOUND");
      expect(appended).toHaveLength(0);
    },
  );

  it("AC2 — refuses a ctx whose user no longer exists", async () => {
    const { options, appended } = deps(null);
    const error = (await assertPlatformAdmin(ctxWith(), options).catch(
      (e: unknown) => e,
    )) as AppError;
    expect(error.code).toBe("NOT_FOUND");
    expect(appended).toHaveLength(0);
  });

  it("AC7 — the denial log line carries requestId and userId and nothing else", async () => {
    const { options, warnings } = deps(userWith(undefined));
    await assertPlatformAdmin(ctxWith(), options).catch(() => {});
    expect(Object.keys(warnings[0]!.fields!).sort()).toEqual(["requestId", "userId"]);
    expect(JSON.stringify(warnings[0])).not.toContain("@");
  });

  /**
   * AC5 — the reason the flag is not on the access token. The ctx is identical
   * across both calls (same session, same claims); only the stored document
   * changes, and the second call must already see it.
   */
  it("AC5 — re-reads the flag from the database on every call", async () => {
    let stored: unknown = true;
    const appended: AdminAuditEntry[] = [];
    const options = {
      request: new Request("http://localhost/api/v1/admin/session"),
      action: "admin.session.read",
      log: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        child: () => {
          throw new Error("unused");
        },
      },
      deps: {
        accounts: { findUserById: async () => userWith(stored) },
        audit: { append: async (entry: AdminAuditEntry) => void appended.push(entry) },
      },
    };
    const ctx = ctxWith();

    await expect(assertPlatformAdmin(ctx, options)).resolves.toMatchObject({
      isPlatformAdmin: true,
    });

    stored = false; // revoked mid-session; the access token is untouched
    const error = (await assertPlatformAdmin(ctx, options).catch(
      (e: unknown) => e,
    )) as AppError;

    expect(error.code).toBe("NOT_FOUND");
    expect(appended).toHaveLength(1); // the first call only
  });

  /**
   * AC2, the strongest form: the refusal is byte-identical to what the /api/v1
   * catch-all says about a path that does not exist, so a caller cannot tell
   * "you may not" from "there is nothing here".
   */
  it("AC2 — the refusal is indistinguishable from an unrouted /api/v1 path", async () => {
    const { options } = deps(userWith(undefined));
    const error = (await assertPlatformAdmin(ctxWith(), options).catch(
      (e: unknown) => e,
    )) as AppError;

    const missing = await unrouted(
      new Request("http://localhost/api/v1/admin/session", { method: "GET" }),
      { params: Promise.resolve({ path: ["admin", "session"] }) },
    );
    const body = await missing.json();

    expect(missing.status).toBe(404);
    expect(body.error.code).toBe(error.code);
    expect(body.error.message).toBe(error.message);
  });
});

describe("GET /api/v1/admin/session", () => {
  const request = () => new Request("http://localhost/api/v1/admin/session");
  const NO_PARAMS = { params: Promise.resolve({}) };

  it("AC1 — answers 200 with the actor and nothing tenant-shaped", async () => {
    Object.assign(userDoc, {
      _id: new ObjectId(ADMIN_ID),
      email: "platform-admin@qa.test",
      name: "QA Platform Admin",
      memberships: [{ tenantId: new ObjectId(TENANT_ID), roles: ["owner"] }],
      isPlatformAdmin: true,
    });

    const response = await adminSession(request(), NO_PARAMS);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      userId: ADMIN_ID,
      email: "platform-admin@qa.test",
      isPlatformAdmin: true,
    });
    expect(body.meta.requestId).toBeDefined();
  });

  /**
   * AC10 — the mocks above make this an assertion about the whole call, not
   * about one function: `createRepository` throws, and so does any collection
   * outside the two this surface is allowed to touch.
   */
  it("AC10 — queries no tenant-scoped collection and builds no repository", async () => {
    Object.assign(userDoc, {
      _id: new ObjectId(ADMIN_ID),
      email: "platform-admin@qa.test",
      memberships: [],
      isPlatformAdmin: true,
    });

    const response = await adminSession(request(), NO_PARAMS);

    expect(response.status).toBe(200);
    expect([...new Set(collectionsTouched)].sort()).toEqual(["admin_audit_log", "users"]);
  });

  it("AC6 — one audit row per successful call, and none on refusal", async () => {
    Object.assign(userDoc, {
      _id: new ObjectId(ADMIN_ID),
      email: "platform-admin@qa.test",
      memberships: [],
      isPlatformAdmin: true,
    });
    await adminSession(request(), NO_PARAMS);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ action: "admin.session.read", targetTenantId: null });
    expect(JSON.stringify(auditRows[0])).not.toContain("@");

    userDoc.isPlatformAdmin = "true"; // truthy, not true
    const refused = await adminSession(request(), NO_PARAMS);
    expect(refused.status).toBe(404);
    expect(auditRows).toHaveLength(1);
  });
});
