/**
 * Cross-tenant user reads. The claims that matter: a password hash on the
 * document can never reach the output, filters are built from validated input
 * only, and nothing here constructs the ctx-scoped repository.
 */
import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/repositories/base", () => ({
  createRepository: vi.fn(() => {
    throw new Error("createRepository must never be constructed by the admin read surface");
  }),
}));

import { AppError } from "@/server/http/envelope";
import {
  buildUserFilter,
  listAdminUsers,
  toAdminUser,
  uniqueIds,
  type AdminUserDoc,
  type AdminUserStore,
} from "./admin-users";

const oid = (n: number) => new ObjectId(String(n).padStart(24, "0"));

const userDoc = (n: number, over: Partial<AdminUserDoc> = {}): AdminUserDoc => ({
  _id: oid(n),
  email: `user${n}@example.test`,
  name: `User ${n}`,
  emailVerifiedAt: new Date("2026-01-01T00:00:00Z"),
  memberships: [{ tenantId: oid(900), roles: ["owner", "bogus"] }],
  createdAt: new Date("2026-01-01T00:00:00Z"),
  ...over,
});

const fakeStore = (docs: AdminUserDoc[]): AdminUserStore & { filters: unknown[] } => {
  const filters: unknown[] = [];
  return {
    filters,
    listUsers: async (filter, limit) => {
      filters.push(filter);
      return docs.slice(0, limit);
    },
    tenantLabels: async (ids) =>
      new Map(ids.map((id) => [id.toHexString(), { name: "Acme", slug: "acme" }])),
  };
};

describe("toAdminUser", () => {
  it("names every field, so a password hash on the document is never emitted", () => {
    const doc = { ...userDoc(1), passwordHash: "$argon2id$secret" } as AdminUserDoc;
    const user = toAdminUser(doc, new Map());
    expect(JSON.stringify(user)).not.toContain("argon2");
    expect(Object.keys(user).sort()).toEqual([
      "createdAt",
      "email",
      "emailVerified",
      "id",
      "isPlatformAdmin",
      "memberships",
      "name",
    ]);
  });

  it("drops unknown roles and only promotes a strict `true` platform flag", () => {
    const user = toAdminUser(userDoc(1, { isPlatformAdmin: "yes" }), new Map());
    expect(user.isPlatformAdmin).toBe(false);
    expect(user.memberships[0]?.roles).toEqual(["owner"]);
    expect(toAdminUser(userDoc(2, { isPlatformAdmin: true }), new Map()).isPlatformAdmin).toBe(
      true,
    );
  });

  it("reports an unverified user as such", () => {
    expect(toAdminUser(userDoc(1, { emailVerifiedAt: null }), new Map()).emailVerified).toBe(
      false,
    );
  });
});

describe("buildUserFilter", () => {
  it("escapes q and searches email and name", () => {
    const filter = buildUserFilter({ q: "a.b" }) as { $or: { email: { $regex: string } }[] };
    expect(filter.$or[0]?.email.$regex).toBe("a\\.b");
  });

  it("combines tenant and role into one membership match", () => {
    const filter = buildUserFilter({ tenantId: oid(5).toHexString(), role: "owner" });
    expect(filter.memberships).toEqual({ $elemMatch: { tenantId: oid(5), roles: "owner" } });
  });

  it("maps the verified and platformAdmin toggles", () => {
    expect(buildUserFilter({ verified: "false" }).emailVerifiedAt).toBeNull();
    expect(buildUserFilter({ verified: "true" }).emailVerifiedAt).toEqual({ $ne: null });
    expect(buildUserFilter({ platformAdmin: "true" }).isPlatformAdmin).toBe(true);
    expect(buildUserFilter({ platformAdmin: "false" }).isPlatformAdmin).toEqual({ $ne: true });
  });
});

describe("listAdminUsers", () => {
  it("pages by over-fetching one row and resolves membership tenant labels", async () => {
    const store = fakeStore([userDoc(3), userDoc(2), userDoc(1)]);
    const result = await listAdminUsers({ limit: "2" }, { store });
    expect(result.items).toHaveLength(2);
    expect(result.meta.hasMore).toBe(true);
    expect(result.items[0]?.memberships[0]?.tenantName).toBe("Acme");
  });

  it("rejects an invalid query with VALIDATION_FAILED before touching the store", async () => {
    const store = fakeStore([]);
    await expect(listAdminUsers({ role: "god" }, { store })).rejects.toBeInstanceOf(AppError);
    expect(store.filters).toHaveLength(0);
  });

  it("de-duplicates tenant ids before asking for labels", () => {
    expect(uniqueIds([oid(1), oid(1), null, oid(2)])).toHaveLength(2);
  });
});
