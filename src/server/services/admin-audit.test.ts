import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GRAFT-27.1 AC6/AC7 — what a platform-admin action leaves behind.
 *
 * Two claims are under test, and they are the whole point of the collection:
 *
 *  - exactly five fields are written, and none of them is personal data. The
 *    writer builds its document from an explicit allow-list, so the test feeds
 *    it an email address, a request body and a password and asserts none of it
 *    survives — a caller cannot widen the row by passing more (AC6).
 *  - the collection is append-only. The store exposes `append` and nothing
 *    else; there is no update or delete path to test because there is none to
 *    write (AC7's second half).
 */

const insertOne = vi.fn(async (_doc: Record<string, unknown>) => ({ insertedId: "x" }));
const collection = vi.fn(() => ({ insertOne }));

vi.mock("@/server/db/mongo", () => ({
  getDb: async () => ({ collection }),
}));

import {
  ADMIN_AUDIT_COLLECTION,
  ADMIN_AUDIT_FIELDS,
  mongoAdminAuditStore,
  recordAdminAction,
  type AdminAuditEntry,
} from "./admin-audit";

beforeEach(() => {
  insertOne.mockClear();
  collection.mockClear();
});

const AT = new Date("2026-09-18T10:00:00.000Z");

describe("recordAdminAction", () => {
  it("AC6 — appends exactly one document with exactly the contracted fields", async () => {
    const appended: AdminAuditEntry[] = [];

    await recordAdminAction(
      {
        actorUserId: "000000000000000000000050",
        action: "admin.session.read",
        targetTenantId: "000000000000000000000002",
        requestId: "req-1",
      },
      { audit: { append: async (entry) => void appended.push(entry) }, now: () => AT },
    );

    expect(appended).toHaveLength(1);
    expect(appended[0]).toEqual({
      actorUserId: "000000000000000000000050",
      action: "admin.session.read",
      targetTenantId: "000000000000000000000002",
      requestId: "req-1",
      at: AT,
    });
    // The field list is the contract, not an incidental shape.
    expect(Object.keys(appended[0]!).sort()).toEqual([...ADMIN_AUDIT_FIELDS].sort());
  });

  it("AC6 — records a null target when the action names no tenant", async () => {
    const appended: AdminAuditEntry[] = [];
    await recordAdminAction(
      { actorUserId: "000000000000000000000050", action: "admin.session.read", requestId: "r" },
      { audit: { append: async (entry) => void appended.push(entry) }, now: () => AT },
    );
    expect(appended[0]!.targetTenantId).toBeNull();
  });

  /**
   * The security claim, phrased the way an attacker would try it: hand the
   * writer more than the contract allows and check that the extra never lands.
   * `as never` because the type already refuses this — the test is about what
   * happens when a future caller casts past it, which is how PII actually gets
   * into audit rows.
   */
  it("AC6 — drops anything that is not a contracted field, including PII", async () => {
    const appended: AdminAuditEntry[] = [];
    await recordAdminAction(
      {
        actorUserId: "000000000000000000000050",
        action: "admin.session.read",
        requestId: "r",
        email: "platform-admin@qa.test",
        body: { password: "hunter2" },
        name: "QA Platform Admin",
      } as never,
      { audit: { append: async (entry) => void appended.push(entry) }, now: () => AT },
    );

    const written = JSON.stringify(appended[0]);
    expect(written).not.toContain("@");
    expect(written).not.toContain("hunter2");
    expect(written).not.toContain("QA Platform Admin");
    expect(Object.keys(appended[0]!).sort()).toEqual([...ADMIN_AUDIT_FIELDS].sort());
  });

  it("stamps `at` from the clock rather than from the caller", async () => {
    const appended: AdminAuditEntry[] = [];
    await recordAdminAction(
      {
        actorUserId: "000000000000000000000050",
        action: "a",
        requestId: "r",
        at: new Date("1999-01-01T00:00:00.000Z"),
      } as never,
      { audit: { append: async (entry) => void appended.push(entry) }, now: () => AT },
    );
    expect(appended[0]!.at).toEqual(AT);
  });
});

describe("mongoAdminAuditStore", () => {
  it("AC7 — writes to admin_audit_log with insertOne and exposes no other verb", async () => {
    const store = mongoAdminAuditStore();
    expect(Object.keys(store)).toEqual(["append"]);

    await store.append({
      actorUserId: "000000000000000000000050",
      action: "admin.session.read",
      targetTenantId: null,
      requestId: "req-9",
      at: AT,
    });

    expect(collection).toHaveBeenCalledWith(ADMIN_AUDIT_COLLECTION);
    expect(insertOne).toHaveBeenCalledTimes(1);
    expect(insertOne.mock.calls[0]![0]).toMatchObject({
      action: "admin.session.read",
      targetTenantId: null,
      requestId: "req-9",
      at: AT,
    });
  });
});
