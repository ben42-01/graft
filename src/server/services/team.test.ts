/**
 * Team invites and membership — unit coverage (GRAFT-33.1 AC1–AC7).
 *
 * Runs against fake ports: an in-memory invites repository scoped to one
 * tenant, a members list, and a spy for the accounts store. Persistence and
 * cross-tenant scoping are proven for real by bruno/team/*.bru.
 */
import { createHash } from "node:crypto";
import { ObjectId, type WithId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { createContext, type Ctx, type Role } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import type { Repository } from "@/server/repositories/base";
import type { Entitlements } from "@/server/services/entitlements";
import {
  createInvite,
  getTeam,
  INVITE_TTL_MS,
  isPending,
  removeMember,
  revokeInvite,
  seatsUsed,
  type InviteDoc,
  type TeamDeps,
  type TeamMember,
} from "./team";

/** The member store's one query, answered from `usersInDb`. */
const { usersInDb, usersQuery } = vi.hoisted(() => ({
  usersInDb: [] as {
    _id: unknown;
    email: string;
    memberships?: { tenantId: unknown; roles: string[] }[];
  }[],
  usersQuery: vi.fn(),
}));
vi.mock("@/server/db/mongo", () => ({
  getDb: async () => ({
    collection: () => ({
      find: (filter: unknown, options: unknown) => {
        usersQuery(filter, options);
        return { sort: () => ({ toArray: async () => usersInDb }) };
      },
    }),
  }),
}));

const TENANT = "000000000000000000000002";
const OWNER = "00000000000000000000000c";
const MEMBER = "00000000000000000000000d";
const NOW = new Date("2026-09-28T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const ctxAs = (role: Role, userId = OWNER): Ctx =>
  createContext({
    requestId: `req-team-${role}`,
    tenantId: TENANT,
    userId,
    roles: [role],
    tier: "premium",
  });

const entitlementsWith = (seats: number | null): Entitlements =>
  ({ tenantId: TENANT, limits: { seats } }) as unknown as Entitlements;

type Row = WithId<InviteDoc>;

const invite = (fields: Partial<InviteDoc> = {}): Row => ({
  _id: new ObjectId(),
  tenantId: new ObjectId(TENANT),
  role: "member",
  email: null,
  tokenHash: "h".repeat(64),
  createdBy: new ObjectId(OWNER),
  createdAt: NOW,
  expiresAt: new Date(NOW.getTime() + DAY),
  acceptedAt: null,
  revokedAt: null,
  ...fields,
});

/** Only the methods team.ts calls; the rest would be a lie about coverage. */
function fakeInvites(rows: Row[] = []) {
  const docs = [...rows];
  const repo = {
    async find() {
      return docs;
    },
    async insertOne(_ctx: Ctx, doc: Omit<InviteDoc, "tenantId" | "createdAt">) {
      const row = {
        ...doc,
        _id: new ObjectId(),
        tenantId: new ObjectId(TENANT),
        createdAt: NOW,
      } as Row;
      docs.push(row);
      return row;
    },
    async updateOne(
      _ctx: Ctx,
      filter: { _id: ObjectId },
      update: { $set: Partial<InviteDoc> },
    ) {
      const row = docs.find(
        (d) => d._id.equals(filter._id) && d.revokedAt === null && d.acceptedAt === null,
      );
      if (!row) return null;
      Object.assign(row, update.$set);
      return row;
    },
  } as unknown as Repository<InviteDoc>;
  return { repo, docs };
}

const MEMBERS: TeamMember[] = [
  { userId: OWNER, email: "owner@example.test", roles: ["owner"] },
  { userId: MEMBER, email: "member@example.test", roles: ["member"] },
];

function deps(overrides: Partial<TeamDeps> = {}, rows: Row[] = []) {
  const invites = fakeInvites(rows);
  const removeMembership = vi.fn(async () => true);
  const d: Partial<TeamDeps> = {
    invites: invites.repo,
    members: { listMembers: async () => MEMBERS },
    accounts: { removeMembership },
    entitlements: async () => entitlementsWith(15),
    appUrl: () => "https://app.example.test",
    now: () => NOW,
    ...overrides,
  };
  return { d, docs: invites.docs, removeMembership };
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof AppError ? { code: error.code, details: error.details } : error;
  }
  return "resolved";
};

describe("createInvite", () => {
  it("AC1 — returns a link carrying a token, stores only its hash, expires in 7 days", async () => {
    const { d, docs } = deps();
    const result = await createInvite(ctxAs("owner"), { role: "member" }, d);

    const token = /^https:\/\/app\.example\.test\/invite\/([A-Za-z0-9_-]{43})$/.exec(
      result.url,
    )?.[1];
    expect(token).toBeDefined();
    expect(docs).toHaveLength(1);
    const stored = docs[0];
    expect(stored.tokenHash).toBe(createHash("sha256").update(token!).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored.expiresAt.getTime() - NOW.getTime()).toBe(INVITE_TTL_MS);
    expect(INVITE_TTL_MS).toBe(7 * DAY);
    expect(stored.createdBy.toHexString()).toBe(OWNER);
    expect(result.invite).toEqual({
      id: stored._id.toHexString(),
      role: "member",
      email: null,
      expiresAt: stored.expiresAt.toISOString(),
    });
  });

  it("AC1 — keeps a normalised email and an admin role", async () => {
    const { d, docs } = deps();
    await createInvite(ctxAs("owner"), { role: "admin", email: " Sam@Example.TEST " }, d);
    expect(docs[0]).toMatchObject({ role: "admin", email: "sam@example.test" });
  });

  it.each([
    [{ role: "owner" }],
    [{ role: "superuser" }],
    [{}],
    [{ role: "member", email: "not-an-email" }],
    [{ role: "member", tenantId: TENANT }],
    [null],
  ])("AC2 — %j is VALIDATION_FAILED", async (body) => {
    const { d, docs } = deps();
    expect(await code(createInvite(ctxAs("owner"), body, d))).toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(docs).toHaveLength(0);
  });

  it("AC3 — refuses at the seat limit with the shared quota shape", async () => {
    const { d, docs } = deps({ entitlements: async () => entitlementsWith(3) }, [invite()]);
    expect(await code(createInvite(ctxAs("owner"), { role: "member" }, d))).toEqual({
      code: "QUOTA_EXCEEDED",
      details: { meter: "seats", limit: 3, used: 3, reason: "quota_exceeded" },
    });
    expect(docs).toHaveLength(1);
  });

  it("AC3 — on Free (limit 1) the very first invite is refused", async () => {
    const { d } = deps({
      entitlements: async () => entitlementsWith(1),
      members: { listMembers: async () => [MEMBERS[0]] },
    });
    expect(await code(createInvite(ctxAs("owner"), { role: "member" }, d))).toMatchObject({
      code: "QUOTA_EXCEEDED",
      details: { meter: "seats", limit: 1, used: 1 },
    });
  });

  it("AC3 — an unlimited plan never refuses", async () => {
    const { d, docs } = deps({ entitlements: async () => entitlementsWith(null) });
    await createInvite(ctxAs("owner"), { role: "member" }, d);
    expect(docs).toHaveLength(1);
  });
});

describe("seat arithmetic (AC3, AC6)", () => {
  it("counts only unexpired, unrevoked, unaccepted invites", () => {
    const rows = [
      invite(),
      invite({ expiresAt: new Date(NOW.getTime() - 1) }),
      invite({ expiresAt: NOW }),
      invite({ revokedAt: NOW }),
      invite({ acceptedAt: NOW }),
    ];
    expect(rows.map((row) => isPending(row, NOW))).toEqual([true, false, false, false, false]);
    expect(seatsUsed(2, rows, NOW)).toBe(3);
  });
});

describe("owner-only (AC4)", () => {
  it.each(["admin", "member"] as const)(
    "%s is FORBIDDEN everywhere, before any read or write",
    async (role) => {
      const listMembers = vi.fn(async () => MEMBERS);
      const entitlements = vi.fn(async () => entitlementsWith(15));
      const { d, docs, removeMembership } = deps({ members: { listMembers }, entitlements }, [
        invite(),
      ]);
      const ctx = ctxAs(role, MEMBER);

      for (const call of [
        createInvite(ctx, { role: "member" }, d),
        createInvite(ctx, { role: "owner" }, d),
        getTeam(ctx, d),
        revokeInvite(ctx, docs[0]._id.toHexString(), d),
        removeMember(ctx, OWNER, d),
      ]) {
        expect(await code(call)).toMatchObject({ code: "FORBIDDEN" });
      }
      expect(listMembers).not.toHaveBeenCalled();
      expect(entitlements).not.toHaveBeenCalled();
      expect(removeMembership).not.toHaveBeenCalled();
      expect(docs).toHaveLength(1);
      expect(docs[0].revokedAt).toBeNull();
    },
  );
});

describe("getTeam (AC5)", () => {
  it("lists members with isYou, pending invites only, and seats — never a hash", async () => {
    const pending = invite({ role: "admin", email: "sam@example.test" });
    const { d } = deps({}, [pending, invite({ revokedAt: NOW }), invite({ acceptedAt: NOW })]);
    const team = await getTeam(ctxAs("owner"), d);

    expect(team.members).toEqual([
      { userId: OWNER, email: "owner@example.test", roles: ["owner"], isYou: true },
      { userId: MEMBER, email: "member@example.test", roles: ["member"], isYou: false },
    ]);
    expect(team.invites).toEqual([
      {
        id: pending._id.toHexString(),
        role: "admin",
        email: "sam@example.test",
        expiresAt: pending.expiresAt.toISOString(),
      },
    ]);
    expect(team.seats).toEqual({ used: 3, limit: 15 });
    expect(JSON.stringify(team)).not.toContain("tokenHash");
    expect(JSON.stringify(team)).not.toContain(pending.tokenHash);
  });
});

describe("revokeInvite (AC6)", () => {
  it("revokes, so the invite leaves the list and frees its seat", async () => {
    const pending = invite();
    const { d } = deps({}, [pending]);
    expect((await getTeam(ctxAs("owner"), d)).seats.used).toBe(3);

    await revokeInvite(ctxAs("owner"), pending._id.toHexString(), d);

    const team = await getTeam(ctxAs("owner"), d);
    expect(team.invites).toEqual([]);
    expect(team.seats.used).toBe(2);
  });

  it("an id the tenant-scoped repository cannot find is NOT_FOUND", async () => {
    const { d } = deps();
    expect(
      await code(revokeInvite(ctxAs("owner"), new ObjectId().toHexString(), d)),
    ).toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("a malformed id is VALIDATION_FAILED", async () => {
    const { d } = deps();
    expect(await code(revokeInvite(ctxAs("owner"), "nope", d))).toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});

describe("removeMember (AC7)", () => {
  it("removes only this tenant's membership", async () => {
    const { d, removeMembership } = deps();
    await removeMember(ctxAs("owner"), MEMBER, d);
    expect(removeMembership).toHaveBeenCalledWith(MEMBER, TENANT);
  });

  it("the owner cannot remove themselves", async () => {
    const { d, removeMembership } = deps();
    expect(await code(removeMember(ctxAs("owner"), OWNER, d))).toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(removeMembership).not.toHaveBeenCalled();
  });

  it("someone who is not a member of this tenant is NOT_FOUND", async () => {
    const { d, removeMembership } = deps();
    expect(
      await code(removeMember(ctxAs("owner"), new ObjectId().toHexString(), d)),
    ).toMatchObject({
      code: "NOT_FOUND",
    });
    expect(removeMembership).not.toHaveBeenCalled();
  });

  it("a membership that vanished between read and write is NOT_FOUND", async () => {
    const { d } = deps({ accounts: { removeMembership: async () => false } });
    expect(await code(removeMember(ctxAs("owner"), MEMBER, d))).toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("a malformed id is VALIDATION_FAILED", async () => {
    const { d } = deps();
    expect(await code(removeMember(ctxAs("owner"), "nope", d))).toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("a second owner is never removable", async () => {
    const other = { userId: MEMBER, email: "co@example.test", roles: ["owner"] as Role[] };
    const { d, removeMembership } = deps({
      members: { listMembers: async () => [MEMBERS[0], other] },
    });
    expect(await code(removeMember(ctxAs("owner"), MEMBER, d))).toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(removeMembership).not.toHaveBeenCalled();
  });
});

describe("default wiring", () => {
  it("reads members from users by this tenant's membership, projecting no hash", async () => {
    const tid = new ObjectId(TENANT);
    usersInDb.splice(0, usersInDb.length, {
      _id: new ObjectId(OWNER),
      email: "owner@example.test",
      memberships: [
        { tenantId: new ObjectId(), roles: ["member"] },
        { tenantId: tid, roles: ["owner", "not-a-role"] },
      ],
    });
    const { d } = deps();
    const team = await getTeam(ctxAs("owner"), {
      invites: d.invites,
      entitlements: d.entitlements,
    });

    expect(usersQuery).toHaveBeenCalledWith(
      { "memberships.tenantId": tid },
      { projection: { email: 1, memberships: 1 } },
    );
    expect(team.members).toEqual([
      { userId: OWNER, email: "owner@example.test", roles: ["owner"], isYou: true },
    ]);
    expect(team.seats).toEqual({ used: 1, limit: 15 });
  });

  it("builds the invite link from APP_URL", async () => {
    vi.stubEnv("APP_ENV", "qa");
    vi.stubEnv("MONGODB_URI", "mongodb://localhost:27017/graft");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("APP_URL", "https://graft.example.test");
    const { d } = deps();
    const { url } = await createInvite(
      ctxAs("owner"),
      { role: "member" },
      { ...d, appUrl: undefined },
    );
    expect(url.startsWith("https://graft.example.test/invite/")).toBe(true);
    vi.unstubAllEnvs();
  });
});
