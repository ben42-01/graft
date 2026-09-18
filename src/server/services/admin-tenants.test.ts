/**
 * GRAFT-27.2 — the cross-tenant admin read service.
 *
 * These are the unit tests the Test Contract names, and they carry the four
 * claims that cannot be proven by looking at the code:
 *
 *   - AC2  paging is stable and every tenant appears exactly once;
 *   - AC3  `q` is a literal, escaped before it reaches Mongo;
 *   - AC5  the detail read resolves entitlements rather than echoing the tier;
 *   - AC8  the serialiser is an allow-list, so a Stripe id or an email on the
 *          tenant document cannot reach a response body by default;
 *   - AC10 nothing here constructs the ctx-scoped repository layer.
 *
 * AC10 is enforced structurally: `@/server/repositories/base` is mocked so that
 * `createRepository` throws if it is ever called, for the whole file. A future
 * edit that reaches for the repository fails this suite rather than silently
 * scoping the admin surface to the caller's own tenant.
 */
import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createRepositorySpy = vi.fn(() => {
  throw new Error(
    "createRepository must never be constructed by the admin read surface (AC10)",
  );
});

vi.mock("@/server/repositories/base", () => ({
  createRepository: createRepositorySpy,
}));

import { AppError } from "@/server/http/envelope";
import { DEFAULT_LIMIT, MAX_LIMIT, decodeCursor } from "@/server/http/pagination";
import { TIER_LIMITS } from "@/server/tiers";
import {
  adminTenantListQuerySchema,
  adminTenantParamsSchema,
  getAdminTenant,
  listAdminTenants,
  toTenantDetail,
  toTenantSummary,
  type AdminTenantDoc,
  type AdminTenantStore,
} from "./admin-tenants";

const oid = (n: number) => new ObjectId(String(n).padStart(24, "0"));

const tenantDoc = (n: number, over: Partial<AdminTenantDoc> = {}): AdminTenantDoc => ({
  _id: oid(n),
  name: `Tenant ${n}`,
  slug: `tenant-${n}`,
  tier: "free",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  billingAnchorDay: 1,
  ...over,
});

/**
 * A store double that behaves like the Mongo one: descending `_id`, the cursor
 * applied as `_id < cursor`, `limit + 1` rows fetched. The filter it is handed
 * is captured so AC3/AC4 can assert on what *would* reach the driver.
 */
function fakeStore(docs: AdminTenantDoc[]) {
  const calls: { filter: Record<string, unknown>; limit: number }[] = [];
  const store: AdminTenantStore = {
    async listTenants(filter, limit) {
      calls.push({ filter: filter as Record<string, unknown>, limit });
      const sorted = [...docs].sort((a, b) =>
        a._id.toHexString() < b._id.toHexString() ? 1 : -1,
      );
      const before = (filter as { _id?: { $lt?: ObjectId } })._id?.$lt;
      const after = before
        ? sorted.filter((d) => d._id.toHexString() < before.toHexString())
        : sorted;
      return after.slice(0, limit);
    },
    async findTenant(id) {
      return docs.find((d) => d._id.toHexString() === id) ?? null;
    },
  };
  return { store, calls };
}

beforeEach(() => {
  createRepositorySpy.mockClear();
});

describe("AC10 — the admin surface is not tenant-scoped", () => {
  it("lists without ever constructing the ctx-injecting repository", async () => {
    const { store } = fakeStore([tenantDoc(1), tenantDoc(2)]);
    await listAdminTenants({}, { store });
    expect(createRepositorySpy).not.toHaveBeenCalled();
  });

  it("reads a detail without ever constructing the repository", async () => {
    const { store } = fakeStore([tenantDoc(1)]);
    await getAdminTenant(oid(1).toHexString(), { store });
    expect(createRepositorySpy).not.toHaveBeenCalled();
  });

  it("never puts a tenantId equality filter on the list query", async () => {
    const { store, calls } = fakeStore([tenantDoc(1)]);
    await listAdminTenants({ q: "tenant" }, { store });
    expect(calls[0]?.filter).not.toHaveProperty("tenantId");
  });
});

describe("AC2 — paging", () => {
  const docs = Array.from({ length: 7 }, (_, i) => tenantDoc(i + 1));

  it("defaults to DEFAULT_LIMIT and caps at MAX_LIMIT", async () => {
    const { store, calls } = fakeStore(docs);
    const first = await listAdminTenants({}, { store });
    expect(first.meta.limit).toBe(DEFAULT_LIMIT);
    // limit + 1 is the over-fetch that makes `hasMore` knowable.
    expect(calls[0]?.limit).toBe(DEFAULT_LIMIT + 1);

    const capped = await listAdminTenants({ limit: "5000" }, { store });
    expect(capped.meta.limit).toBe(MAX_LIMIT);
  });

  it("walks every tenant exactly once across pages under a stable sort", async () => {
    const { store } = fakeStore(docs);
    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;

    do {
      const page: Awaited<ReturnType<typeof listAdminTenants>> = await listAdminTenants(
        { limit: "3", ...(cursor ? { cursor } : {}) },
        { store },
      );
      seen.push(...page.items.map((t) => t.id));
      cursor = page.meta.cursor;
      expect(guard++).toBeLessThan(10);
    } while (cursor);

    expect(seen).toHaveLength(docs.length);
    expect(new Set(seen).size).toBe(docs.length);
    // Descending `_id` — the stable sort the cursor is issued against.
    expect(seen).toEqual([...seen].sort().reverse());
  });

  it("reports hasMore and an opaque cursor that decodes to the last row", async () => {
    const { store } = fakeStore(docs);
    const page = await listAdminTenants({ limit: "3" }, { store });
    expect(page.items).toHaveLength(3);
    expect(page.meta.hasMore).toBe(true);
    expect(page.meta.cursor).toBeTypeOf("string");
    expect(decodeCursor(page.meta.cursor as string).id).toBe(page.items[2]?.id);
  });

  it("closes the last page with hasMore false and a null cursor", async () => {
    const { store } = fakeStore(docs.slice(0, 2));
    const page = await listAdminTenants({ limit: "3" }, { store });
    expect(page.meta.hasMore).toBe(false);
    expect(page.meta.cursor).toBeNull();
  });
});

describe("AC3 — search is a literal, escaped before it reaches Mongo", () => {
  const hostile = [".*", "$ne", "^qa", "a|b", "(x)", "[a-z]", "tenant-1\\"];

  it.each(hostile)("escapes %j so it cannot act as a pattern", async (term) => {
    const { store, calls } = fakeStore([tenantDoc(1)]);
    await listAdminTenants({ q: term }, { store });

    const or = calls[0]?.filter.$or as { name?: { $regex: string } }[] | undefined;
    const regex = or?.[0]?.name?.$regex as string;
    expect(regex).toBeTypeOf("string");
    // The escaped form matches the term as text and nothing else.
    expect(new RegExp(regex).test(term)).toBe(true);
    expect(new RegExp(regex).test("something-entirely-different")).toBe(false);
  });

  it("sends `.*` to Mongo as the literal two characters, so it matches nothing", async () => {
    const { store, calls } = fakeStore([tenantDoc(1), tenantDoc(2)]);
    await listAdminTenants({ q: ".*" }, { store });
    const or = calls[0]?.filter.$or as { name?: { $regex: string } }[];
    expect(or[0]?.name?.$regex).toBe("\\.\\*");
    // No tenant name or slug in the fixture set contains a literal ".*".
    expect(new RegExp(or[0]?.name?.$regex as string, "i").test("Tenant 1")).toBe(false);
  });

  it("sends `$ne` as text, so an operator-shaped term cannot become an operator", async () => {
    const { store, calls } = fakeStore([tenantDoc(1)]);
    await listAdminTenants({ q: "$ne" }, { store });
    const or = calls[0]?.filter.$or as { name?: { $regex: string } }[];
    expect(or[0]?.name?.$regex).toBe("\\$ne");
    expect(typeof or[0]?.name?.$regex).toBe("string");
  });

  it("searches name and slug case-insensitively", async () => {
    const { store, calls } = fakeStore([tenantDoc(1)]);
    await listAdminTenants({ q: "Acme" }, { store });
    const or = calls[0]?.filter.$or as {
      name?: { $regex: string; $options: string };
      slug?: { $regex: string; $options: string };
    }[];
    expect(or).toHaveLength(2);
    expect(or[0]?.name?.$options).toBe("i");
    expect(or[1]?.slug?.$options).toBe("i");
  });

  it("treats a blank q as no search at all", async () => {
    const { store, calls } = fakeStore([tenantDoc(1)]);
    await listAdminTenants({ q: "   " }, { store });
    expect(calls[0]?.filter).not.toHaveProperty("$or");
  });
});

describe("AC4 — tier filter", () => {
  it("passes a known tier through as an equality filter", async () => {
    const { store, calls } = fakeStore([tenantDoc(1)]);
    await listAdminTenants({ tier: "premium" }, { store });
    expect(calls[0]?.filter.tier).toBe("premium");
  });

  it("rejects an unknown tier at the boundary rather than returning an empty list", () => {
    const parsed = adminTenantListQuerySchema.safeParse({ tier: "platinum" });
    expect(parsed.success).toBe(false);
  });

  it("refuses an unknown tier inside the service too", async () => {
    const { store } = fakeStore([tenantDoc(1)]);
    await expect(listAdminTenants({ tier: "platinum" }, { store })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});

describe("AC5 — detail resolves entitlements", () => {
  it("returns what the tenant is actually entitled to, not the tier default", async () => {
    const doc = tenantDoc(4, {
      tier: "free",
      // An Enterprise-style negotiated override on a Free tenant: the resolved
      // object must show 999, while the raw bag still shows what was written.
      limits: { seats: 999 },
      readOnly: ["records", "entities"],
      downgradedAt: new Date("2026-02-02T00:00:00.000Z"),
      billingAnchorDay: 9,
    });
    const { store } = fakeStore([doc]);
    const detail = await getAdminTenant(doc._id.toHexString(), { store });

    expect(detail.limits.limits.seats).toBe(999);
    expect(TIER_LIMITS.free.seats).not.toBe(999);
    expect(detail.limits.features).toBeTypeOf("object");
    expect(detail.limitOverrides).toEqual({ seats: 999 });
    expect(detail.readOnly).toEqual(["records", "entities"]);
    expect(detail.readOnlyCount).toBe(2);
    expect(detail.downgradedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(detail.billingAnchorDay).toBe(9);
  });

  it("still carries every AC1 summary field", async () => {
    const doc = tenantDoc(1);
    const { store } = fakeStore([doc]);
    const detail = await getAdminTenant(doc._id.toHexString(), { store });
    for (const key of [
      "id",
      "name",
      "slug",
      "tier",
      "createdAt",
      "readOnlyCount",
      "hasLimitOverrides",
      "billing",
    ]) {
      expect(detail).toHaveProperty(key);
    }
  });
});

describe("AC6 — id validation and absence", () => {
  it("rejects an id that is not 24-hex with VALIDATION_FAILED", async () => {
    const { store } = fakeStore([tenantDoc(1)]);
    await expect(getAdminTenant("nope", { store })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(adminTenantParamsSchema.safeParse({ tenantId: "nope" }).success).toBe(false);
  });

  it("raises NOT_FOUND — never a driver error — for well-formed hex with no tenant", async () => {
    const { store } = fakeStore([tenantDoc(1)]);
    const error = await getAdminTenant(oid(99).toHexString(), { store }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("NOT_FOUND");
    expect((error as AppError).status).toBe(404);
  });
});

describe("AC8 — the serialiser is an allow-list", () => {
  /** Everything a tenant document might plausibly grow that must never escape. */
  const leaky = tenantDoc(2, {
    tier: "premium",
    limits: { seats: 10 },
    readOnly: ["records"],
    billing: {
      stripeCustomerId: "cus_SECRET123",
      stripeSubscriptionId: "sub_SECRET456",
      graceExpiresAt: new Date("2026-03-03T00:00:00.000Z"),
      trialEndsAt: new Date("2026-04-04T00:00:00.000Z"),
    },
  }) as AdminTenantDoc & Record<string, unknown>;
  leaky.ownerEmail = "owner@example.test";
  leaky.contact = { email: "billing@example.test" };
  leaky.stripeSecretKey = "sk_live_should_never_appear";
  leaky.members = [{ email: "member@example.test" }];

  it("emits exactly the AC1 summary keys and no more", () => {
    const summary = toTenantSummary(leaky);
    expect(Object.keys(summary).sort()).toEqual(
      [
        "billing",
        "createdAt",
        "hasLimitOverrides",
        "id",
        "name",
        "readOnlyCount",
        "slug",
        "tier",
      ].sort(),
    );
    expect(Object.keys(summary.billing).sort()).toEqual(
      ["graceExpiresAt", "hasCustomer", "hasSubscription", "trialEndsAt"].sort(),
    );
  });

  it("emits exactly the AC5 detail keys and no more", () => {
    const detail = toTenantDetail(leaky);
    expect(Object.keys(detail).sort()).toEqual(
      [
        "billing",
        "billingAnchorDay",
        "createdAt",
        "downgradedAt",
        "hasLimitOverrides",
        "id",
        "limitOverrides",
        "limits",
        "name",
        "readOnly",
        "readOnlyCount",
        "slug",
        "tier",
      ].sort(),
    );
  });

  it.each([
    ["summary", () => toTenantSummary(leaky)],
    ["detail", () => toTenantDetail(leaky)],
  ])("leaks no Stripe id, secret or email from the %s", (_label, build) => {
    const serialised = JSON.stringify(build());
    for (const forbidden of [
      "cus_",
      "sub_",
      "sk_live",
      "SECRET",
      "@example.test",
      "ownerEmail",
      "email",
      "stripe",
      "Stripe",
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it("reports billing presence as booleans only", () => {
    const summary = toTenantSummary(leaky);
    expect(summary.billing.hasCustomer).toBe(true);
    expect(summary.billing.hasSubscription).toBe(true);
    expect(summary.billing.graceExpiresAt).toBe("2026-03-03T00:00:00.000Z");
    expect(summary.billing.trialEndsAt).toBe("2026-04-04T00:00:00.000Z");

    const bare = toTenantSummary(tenantDoc(3));
    expect(bare.billing).toEqual({
      hasCustomer: false,
      hasSubscription: false,
      graceExpiresAt: null,
      trialEndsAt: null,
    });
  });

  it("derives readOnlyCount and hasLimitOverrides rather than exposing raw internals", () => {
    expect(toTenantSummary(leaky).readOnlyCount).toBe(1);
    expect(toTenantSummary(leaky).hasLimitOverrides).toBe(true);
    expect(toTenantSummary(tenantDoc(3)).readOnlyCount).toBe(0);
    expect(toTenantSummary(tenantDoc(3)).hasLimitOverrides).toBe(false);
  });

  it("falls back to safe values for a malformed document rather than throwing", () => {
    const broken = { _id: oid(5) } as AdminTenantDoc;
    const summary = toTenantSummary(broken);
    expect(summary.id).toBe(oid(5).toHexString());
    expect(summary.tier).toBe("free");
    expect(summary.name).toBe("");
    expect(summary.createdAt).toBeNull();
  });
});
