/**
 * GRAFT-29.2 — the cross-tenant admin activity read service.
 *
 * These are the unit tests the Test Contract names, and they carry the claims
 * that cannot be proven by looking at the code:
 *
 *   - AC1  paging is stable, descending `_id`, same shape as admin-tenants;
 *   - AC2  a `tenantId` filter narrows the query, a malformed one is a 400;
 *   - AC3  `action` supports exact and family-prefix match, and an
 *          unregistered action/family is a 400, never an empty list;
 *   - AC4  `q` only ever touches the declared searchable fields, never a
 *          schemaless regex over the whole context sub-document;
 *   - AC5  `from`/`to` are validated ISO dates, inclusive, and `from` after
 *          `to` is a 400;
 *   - AC6  the serialiser is an allow-list, so an unregistered context field
 *          cannot reach a response body by default.
 *
 * AC1's "never reaches the repository" claim is enforced structurally, exactly
 * as admin-tenants.test.ts does it: `@/server/repositories/base` is mocked to
 * throw for the whole file.
 */
import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createRepositorySpy = vi.fn(() => {
  throw new Error("createRepository must never be constructed by the admin read surface (AC1)");
});

vi.mock("@/server/repositories/base", () => ({
  createRepository: createRepositorySpy,
}));

import { DEFAULT_LIMIT, MAX_LIMIT, decodeCursor } from "@/server/http/pagination";
import {
  adminActivityListQuerySchema,
  buildActivityFilter,
  isValidActionFilter,
  listAdminActivities,
  toActivitySummary,
  type AdminActivityDoc,
  type AdminActivityStore,
} from "./admin-activities";

const oid = (n: number) => new ObjectId(String(n).padStart(24, "0"));

const activityDoc = (n: number, over: Partial<AdminActivityDoc> = {}): AdminActivityDoc => ({
  _id: oid(n),
  tenantId: oid(1),
  actorType: "customer",
  actorId: oid(11),
  action: "account.login",
  ok: true,
  requestId: `req-${n}`,
  at: new Date("2026-01-15T00:00:00.000Z"),
  context: {},
  ...over,
});

/**
 * A store double behaving like the Mongo one: descending `_id`, the cursor
 * applied as `_id < cursor`, `limit + 1` rows fetched. The filter it is
 * handed is captured so AC2/AC3/AC4 can assert on what *would* reach the
 * driver.
 */
function fakeStore(docs: AdminActivityDoc[]) {
  const calls: { filter: Record<string, unknown>; limit: number }[] = [];
  const store: AdminActivityStore = {
    async listActivities(filter, limit) {
      calls.push({ filter: filter as Record<string, unknown>, limit });
      const sorted = [...docs].sort((a, b) =>
        a._id.toHexString() < b._id.toHexString() ? 1 : -1,
      );
      const before = (filter as { _id?: { $lt?: ObjectId } })._id?.$lt;
      let matched = before
        ? sorted.filter((d) => d._id.toHexString() < before.toHexString())
        : sorted;

      const f = filter as {
        tenantId?: ObjectId;
        actorType?: string;
        action?: string | { $regex: string };
      };
      if (f.tenantId) {
        matched = matched.filter((d) => d.tenantId.equals(f.tenantId as ObjectId));
      }
      if (f.actorType) {
        matched = matched.filter((d) => d.actorType === f.actorType);
      }
      if (f.action) {
        matched =
          typeof f.action === "string"
            ? matched.filter((d) => d.action === f.action)
            : matched.filter((d) =>
                new RegExp((f.action as { $regex: string }).$regex).test(d.action),
              );
      }

      return matched.slice(0, limit);
    },
  };
  return { store, calls };
}

beforeEach(() => {
  createRepositorySpy.mockClear();
});

describe("AC1 — the admin surface is not tenant-scoped", () => {
  it("lists without ever constructing the ctx-injecting repository", async () => {
    const { store } = fakeStore([activityDoc(1), activityDoc(2)]);
    await listAdminActivities({}, { store });
    expect(createRepositorySpy).not.toHaveBeenCalled();
  });

  it("does not filter by tenantId unless the caller asks for it", async () => {
    const { store, calls } = fakeStore([activityDoc(1)]);
    await listAdminActivities({}, { store });
    expect(calls[0]?.filter).not.toHaveProperty("tenantId");
  });
});

describe("AC1 — paging", () => {
  const docs = Array.from({ length: 7 }, (_, i) => activityDoc(i + 1));

  it("defaults to DEFAULT_LIMIT and caps at MAX_LIMIT", async () => {
    const { store, calls } = fakeStore(docs);
    const first = await listAdminActivities({}, { store });
    expect(first.meta.limit).toBe(DEFAULT_LIMIT);
    expect(calls[0]?.limit).toBe(DEFAULT_LIMIT + 1);

    const capped = await listAdminActivities({ limit: "5000" }, { store });
    expect(capped.meta.limit).toBe(MAX_LIMIT);
  });

  it("walks every row exactly once across pages under a stable sort", async () => {
    const { store } = fakeStore(docs);
    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;

    do {
      const p: Awaited<ReturnType<typeof listAdminActivities>> = await listAdminActivities(
        { limit: "3", ...(cursor ? { cursor } : {}) },
        { store },
      );
      seen.push(...p.items.map((a) => a.id));
      cursor = p.meta.cursor;
      expect(guard++).toBeLessThan(10);
    } while (cursor);

    expect(seen).toHaveLength(docs.length);
    expect(new Set(seen).size).toBe(docs.length);
    expect(seen).toEqual([...seen].sort().reverse());
  });

  it("reports hasMore and an opaque cursor that decodes to the last row", async () => {
    const { store } = fakeStore(docs);
    const p = await listAdminActivities({ limit: "3" }, { store });
    expect(p.items).toHaveLength(3);
    expect(p.meta.hasMore).toBe(true);
    expect(decodeCursor(p.meta.cursor as string).id).toBe(p.items[2]?.id);
  });

  it("closes the last page with hasMore false and a null cursor", async () => {
    const { store } = fakeStore(docs.slice(0, 2));
    const p = await listAdminActivities({ limit: "3" }, { store });
    expect(p.meta.hasMore).toBe(false);
    expect(p.meta.cursor).toBeNull();
  });
});

describe("AC2 — tenantId filter", () => {
  it("narrows the query to one tenant", async () => {
    const { store, calls } = fakeStore([activityDoc(1)]);
    await listAdminActivities({ tenantId: oid(3).toHexString() }, { store });
    expect((calls[0]?.filter.tenantId as ObjectId).equals(oid(3))).toBe(true);
  });

  it("rejects a malformed tenantId at the boundary with VALIDATION_FAILED", async () => {
    const { store } = fakeStore([activityDoc(1)]);
    await expect(listAdminActivities({ tenantId: "nope" }, { store })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(adminActivityListQuerySchema.safeParse({ tenantId: "nope" }).success).toBe(false);
  });
});

describe("AC3 — action filter", () => {
  it("accepts an exact family.leaf match", () => {
    expect(isValidActionFilter("account.login")).toBe(true);
    expect(isValidActionFilter("notify.email.sent")).toBe(true);
  });

  it("accepts a family prefix ending in a dot", () => {
    expect(isValidActionFilter("billing.")).toBe(true);
    expect(isValidActionFilter("notify.email.")).toBe(true);
  });

  it("rejects an unregistered family, leaf or malformed string", () => {
    expect(isValidActionFilter("bogus.leaf")).toBe(false);
    expect(isValidActionFilter("account.bogus")).toBe(false);
    expect(isValidActionFilter("bogus.")).toBe(false);
    expect(isValidActionFilter("noDotAtAll")).toBe(false);
  });

  it("refuses an unregistered action at the schema boundary rather than returning an empty list", () => {
    const parsed = adminActivityListQuerySchema.safeParse({ action: "bogus.leaf" });
    expect(parsed.success).toBe(false);
  });

  it("refuses an unregistered action inside the service too", async () => {
    const { store } = fakeStore([activityDoc(1)]);
    await expect(
      listAdminActivities({ action: "bogus.leaf" }, { store }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("builds an exact equality filter for a leaf action", () => {
    const filter = buildActivityFilter(
      adminActivityListQuerySchema.parse({ action: "account.login" }),
    );
    expect(filter.action).toBe("account.login");
  });

  it("builds a prefix regex filter for a family, and it matches every leaf under it", () => {
    const filter = buildActivityFilter(
      adminActivityListQuerySchema.parse({ action: "billing." }),
    );
    const regex = new RegExp((filter.action as { $regex: string }).$regex);
    // Real stored actions are `<family>.<leaf>`, and `billing.subscription` /
    // `billing.payment` are themselves dotted families, so a real leaf action
    // under either one is two dots deep — exactly what the prefix must reach.
    expect(regex.test("billing.subscription.add")).toBe(true);
    expect(regex.test("billing.payment.succeeded")).toBe(true);
    expect(regex.test("account.login")).toBe(false);
  });
});

describe("AC4 — q searches only the declared searchable fields", () => {
  it("matches on notify.email's template field", async () => {
    const doc = activityDoc(1, {
      action: "notify.email.sent",
      context: { template: "welcome-email", to: "person@example.test" },
    });
    const { store, calls } = fakeStore([doc]);
    await listAdminActivities({ q: "welcome" }, { store });
    const or = calls[0]?.filter.$or as { [key: string]: { $regex: string } }[];
    expect(or.some((clause) => "context.template" in clause)).toBe(true);
  });

  it("never builds a regex over the whole context sub-document", async () => {
    const { store, calls } = fakeStore([activityDoc(1)]);
    await listAdminActivities({ q: "anything" }, { store });
    const or = calls[0]?.filter.$or as Record<string, unknown>[];
    for (const clause of or) {
      expect(Object.keys(clause)).not.toContain("context");
    }
  });

  it("escapes the term so it cannot act as a Mongo pattern", async () => {
    const { store, calls } = fakeStore([activityDoc(1)]);
    await listAdminActivities({ q: "$ne" }, { store });
    const or = calls[0]?.filter.$or as { [key: string]: { $regex: string } }[];
    for (const clause of or) {
      const [regex] = Object.values(clause);
      expect(regex.$regex).toBe("\\$ne");
    }
  });

  it("treats a blank q as no search at all", async () => {
    const { store, calls } = fakeStore([activityDoc(1)]);
    await listAdminActivities({ q: "   " }, { store });
    expect(calls[0]?.filter).not.toHaveProperty("$or");
  });
});

describe("AC5 — from/to date range", () => {
  it("accepts a valid inclusive range", () => {
    const parsed = adminActivityListQuerySchema.safeParse({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-31T00:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects from after to", () => {
    const parsed = adminActivityListQuerySchema.safeParse({
      from: "2026-02-01T00:00:00.000Z",
      to: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unparsable date", () => {
    const parsed = adminActivityListQuerySchema.safeParse({ from: "not-a-date" });
    expect(parsed.success).toBe(false);
  });

  it("builds an inclusive $gte/$lte filter on `at`", () => {
    const filter = buildActivityFilter(
      adminActivityListQuerySchema.parse({
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-31T00:00:00.000Z",
      }),
    );
    const at = filter.at as { $gte: Date; $lte: Date };
    expect(at.$gte.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(at.$lte.toISOString()).toBe("2026-01-31T00:00:00.000Z");
  });

  it("refuses an invalid range inside the service too", async () => {
    const { store } = fakeStore([activityDoc(1)]);
    await expect(
      listAdminActivities(
        { from: "2026-02-01T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" },
        { store },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("AC6 — the serialiser is an allow-list", () => {
  it("emits exactly the summary keys and no more", () => {
    const summary = toActivitySummary(activityDoc(1));
    expect(Object.keys(summary).sort()).toEqual(
      ["action", "actorId", "actorType", "at", "context", "id", "ok", "tenantId"].sort(),
    );
  });

  it("never emits requestId — not on the admin allow-list", () => {
    const summary = toActivitySummary(activityDoc(1));
    expect(summary).not.toHaveProperty("requestId");
  });

  it("masks notify.email's `to` field rather than emitting the raw address", () => {
    const doc = activityDoc(1, {
      action: "notify.email.sent",
      context: { template: "welcome-email", to: "person@example.test" },
    });
    const summary = toActivitySummary(doc);
    expect(summary.context.to).not.toBe("person@example.test");
    expect(summary.context.to).toContain("@example.test");
    expect(JSON.stringify(summary)).not.toContain("person@example.test");
  });

  it("carries only the declared display fields for a family, dropping the rest", () => {
    const doc = activityDoc(1, {
      action: "notify.email.failed",
      context: {
        template: "reset-password",
        to: "person@example.test",
        messageId: "msg_123",
        errorCode: "bounce",
      },
    });
    const summary = toActivitySummary(doc);
    expect(Object.keys(summary.context).sort()).toEqual(["template", "to"]);
    expect(JSON.stringify(summary)).not.toContain("msg_123");
    expect(JSON.stringify(summary)).not.toContain("bounce");
  });

  it("emits an empty context for an unregistered/malformed action rather than throwing", () => {
    const doc = activityDoc(1, { action: "totally.bogus", context: { anything: "x" } });
    const summary = toActivitySummary(doc);
    expect(summary.context).toEqual({});
  });

  it("emits a null actorId for a system-fired row", () => {
    const doc = activityDoc(1, { actorType: "system", actorId: null });
    const summary = toActivitySummary(doc);
    expect(summary.actorId).toBeNull();
  });
});
