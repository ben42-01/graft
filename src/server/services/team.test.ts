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
import type { TenantRecord, UserRecord } from "@/server/auth/accounts-store";
import type { Repository } from "@/server/repositories/base";
import type { Entitlements } from "@/server/services/entitlements";
import {
  acceptInvite,
  claimInvite,
  createInvite,
  getTeam,
  INVITE_TTL_MS,
  isPending,
  previewInvite,
  removeMember,
  revokeInvite,
  seatsUsed,
  type InviteDoc,
  type InviteStore,
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

const INVITEE = "00000000000000000000000e";
const TENANT_RECORD = {
  id: TENANT,
  name: "Harbour Boats",
  slug: "harbour-boats",
  tier: "premium",
  limits: {},
  branding: null,
} as unknown as TenantRecord;

const userRecord = (fields: Partial<UserRecord> = {}): UserRecord => ({
  id: INVITEE,
  email: "new@example.test",
  name: null,
  passwordHash: null,
  emailVerifiedAt: null,
  memberships: [],
  isPlatformAdmin: false,
  ...fields,
});

/** The invite store over the same rows the repository fake holds. */
function fakeInviteStore(docs: Row[]) {
  const store = {
    findByTokenHash: vi.fn(
      async (hash: string) => docs.find((d) => d.tokenHash === hash) ?? null,
    ),
    pendingForTenant: vi.fn(async (_tid: ObjectId, now: Date) =>
      docs.filter((d) => isPending(d, now)),
    ),
    claim: vi.fn(async (id: ObjectId, now: Date) => {
      const row = docs.find((d) => d._id.equals(id) && d.acceptedAt === null);
      if (!row) return false;
      row.acceptedAt = now;
      return true;
    }),
    release: vi.fn(async (id: ObjectId) => {
      const row = docs.find((d) => d._id.equals(id));
      if (row) row.acceptedAt = null;
    }),
  } satisfies InviteStore;
  return store;
}

function fakeAccounts(user: UserRecord | null = userRecord()) {
  return {
    removeMembership: vi.fn(async () => true),
    addMembership: vi.fn(async () => true),
    findUserById: vi.fn(async () => user),
    findTenantById: vi.fn(async (id: string) => (id === TENANT ? TENANT_RECORD : null)),
  };
}

function deps(overrides: Partial<TeamDeps> = {}, rows: Row[] = []) {
  const invites = fakeInvites(rows);
  const accounts = fakeAccounts();
  const removeMembership = accounts.removeMembership;
  const inviteStore = fakeInviteStore(invites.docs);
  const d: Partial<TeamDeps> = {
    invites: invites.repo,
    members: { listMembers: async () => MEMBERS },
    accounts,
    inviteStore,
    entitlements: async () => entitlementsWith(15),
    appUrl: () => "https://app.example.test",
    now: () => NOW,
    sendMail: vi.fn(async () => {}),
    ...overrides,
  };
  return { d, docs: invites.docs, removeMembership, accounts, inviteStore };
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

  it("emails the link when an address is given, with replies going to the owner", async () => {
    const sendMail = vi.fn(async () => {});
    const { d } = deps({ sendMail });
    (d.accounts!.findUserById as ReturnType<typeof vi.fn>).mockResolvedValue(
      userRecord({ id: OWNER, email: "owner@example.test" }),
    );
    const result = await createInvite(
      ctxAs("owner"),
      { role: "admin", email: "sam@example.test" },
      d,
    );

    expect(result.emailed).toBe(true);
    expect(sendMail).toHaveBeenCalledOnce();
    const message = (sendMail.mock.calls[0] as unknown[])[0] as Record<string, string>;
    expect(message).toMatchObject({
      kind: "team.invite",
      to: "sam@example.test",
      replyTo: "owner@example.test",
      subject: "You're invited to join Harbour Boats on Graft",
    });
    expect(message.html).toContain(result.url);
    expect(message.text).toContain("Manager");
  });

  it("sends nothing for a link-only invite", async () => {
    const sendMail = vi.fn(async () => {});
    const result = await createInvite(ctxAs("owner"), { role: "member" }, deps({ sendMail }).d);
    expect(result.emailed).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("keeps the invite when the email fails, and says it was not sent", async () => {
    const { d, docs } = deps({ sendMail: vi.fn(async () => Promise.reject(new Error("535"))) });
    const result = await createInvite(
      ctxAs("owner"),
      { role: "member", email: "sam@example.test" },
      d,
    );
    expect(result.emailed).toBe(false);
    expect(result.url).toMatch(/\/invite\//);
    expect(docs).toHaveLength(1);
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
    const { d } = deps({
      accounts: { ...fakeAccounts(), removeMembership: async () => false },
    });
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

// ---------------------------------------------------------------------------
// GRAFT-33.2 — the invitee's side
// ---------------------------------------------------------------------------

const TOKEN = "t".repeat(43);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const pendingRow = (fields: Partial<InviteDoc> = {}) =>
  invite({ tokenHash: sha(TOKEN), ...fields });
const inviteeCtx = () => ctxAs("member", INVITEE);

describe("acceptInvite", () => {
  it("AC1 — adds the invite's own tenant and role, and marks it accepted", async () => {
    const row = pendingRow({ role: "admin" });
    const { d, accounts } = deps({}, [row]);
    const result = await acceptInvite(inviteeCtx(), { token: TOKEN }, d);
    expect(result).toEqual({ tenantId: TENANT, tenantSlug: "harbour-boats", role: "admin" });
    expect(accounts.addMembership).toHaveBeenCalledWith(INVITEE, TENANT, ["admin"]);
    expect(row.acceptedAt).toEqual(NOW);
  });

  it("cross-tenant — a tenantId named in the body is never used", async () => {
    const { d, accounts } = deps({}, [pendingRow()]);
    const other = new ObjectId().toHexString();
    await acceptInvite(inviteeCtx(), { token: TOKEN, tenantId: other, role: "owner" }, d);
    expect(accounts.addMembership).toHaveBeenCalledWith(INVITEE, TENANT, ["member"]);
  });

  it("AC2 — the same token twice: the second is NOT_FOUND", async () => {
    const { d } = deps({}, [pendingRow()]);
    await acceptInvite(inviteeCtx(), { token: TOKEN }, d);
    expect(await code(acceptInvite(inviteeCtx(), { token: TOKEN }, d))).toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it.each([
    ["unknown", undefined],
    ["expired", { expiresAt: new Date(NOW.getTime() - 1) }],
    ["revoked", { revokedAt: NOW }],
  ])("AC2 — a %s token is NOT_FOUND, with the one message", async (_name, fields) => {
    const rows = fields ? [pendingRow(fields)] : [];
    const { d, accounts } = deps({}, rows);
    const error = await code(acceptInvite(inviteeCtx(), { token: TOKEN }, d));
    expect(error).toMatchObject({ code: "NOT_FOUND" });
    expect(accounts.addMembership).not.toHaveBeenCalled();
  });

  it("a body without a token is VALIDATION_FAILED", async () => {
    const { d } = deps();
    expect(await code(acceptInvite(inviteeCtx(), {}, d))).toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("AC3 — a bound email that differs is FORBIDDEN and the invite stays pending", async () => {
    const row = pendingRow({ email: "someone.else@example.test" });
    const { d, accounts } = deps({}, [row]);
    expect(await code(acceptInvite(inviteeCtx(), { token: TOKEN }, d))).toMatchObject({
      code: "FORBIDDEN",
    });
    expect(row.acceptedAt).toBeNull();
    expect(accounts.addMembership).not.toHaveBeenCalled();
  });

  it("AC3 — the email comparison ignores case", async () => {
    const { d } = deps({}, [pendingRow({ email: "new@example.test" })]);
    d.accounts = fakeAccounts(userRecord({ email: "New@Example.TEST" }));
    expect(await acceptInvite(inviteeCtx(), { token: TOKEN }, d)).toMatchObject({
      tenantId: TENANT,
    });
  });

  it("AC4 — an existing member is CONFLICT; roles unchanged, invite pending", async () => {
    const row = pendingRow({ role: "admin" });
    const { d } = deps({}, [row]);
    const member = userRecord({ memberships: [{ tenantId: TENANT, roles: ["member"] }] });
    d.accounts = fakeAccounts(member);
    expect(await code(acceptInvite(inviteeCtx(), { token: TOKEN }, d))).toMatchObject({
      code: "CONFLICT",
    });
    expect(d.accounts.addMembership).not.toHaveBeenCalled();
    expect(row.acceptedAt).toBeNull();
  });

  it("AC5 — over the seat limit is QUOTA_EXCEEDED on seats, and nothing changes", async () => {
    const row = pendingRow();
    // 2 members + this pending invite on a 2-seat plan: the invite's own seat
    // is not counted, so 2 >= 2 refuses.
    const { d, accounts } = deps({ entitlements: async () => entitlementsWith(2) }, [row]);
    const error = await code(acceptInvite(inviteeCtx(), { token: TOKEN }, d));
    expect(error).toMatchObject({
      code: "QUOTA_EXCEEDED",
      details: { meter: "seats", limit: 2, used: 2 },
    });
    expect(row.acceptedAt).toBeNull();
    expect(accounts.addMembership).not.toHaveBeenCalled();
  });

  it("AC5 — the invite's own seat is not double counted at the limit", async () => {
    const { d } = deps({ entitlements: async () => entitlementsWith(3) }, [pendingRow()]);
    expect(await acceptInvite(inviteeCtx(), { token: TOKEN }, d)).toMatchObject({
      tenantId: TENANT,
    });
  });

  it("AC5 — other pending invites do hold seats", async () => {
    const other = invite({ tokenHash: sha("other") });
    const { d } = deps({ entitlements: async () => entitlementsWith(3) }, [
      pendingRow(),
      other,
    ]);
    expect(await code(acceptInvite(inviteeCtx(), { token: TOKEN }, d))).toMatchObject({
      code: "QUOTA_EXCEEDED",
    });
  });

  it("AC8 — a failed membership write releases the claim", async () => {
    const row = pendingRow();
    const { d, inviteStore } = deps({}, [row]);
    d.accounts = {
      ...fakeAccounts(),
      addMembership: vi.fn(async () => {
        throw new Error("mongo went away");
      }),
    };
    await expect(acceptInvite(inviteeCtx(), { token: TOKEN }, d)).rejects.toThrow("mongo");
    expect(inviteStore.claim).toHaveBeenCalledOnce();
    expect(inviteStore.release).toHaveBeenCalledOnce();
    expect(row.acceptedAt).toBeNull();
  });

  it("AC8 — losing the atomic claim to a racing accept is NOT_FOUND, with no membership", async () => {
    const { d, accounts, inviteStore } = deps({}, [pendingRow()]);
    inviteStore.claim.mockResolvedValueOnce(false);
    expect(await code(acceptInvite(inviteeCtx(), { token: TOKEN }, d))).toMatchObject({
      code: "NOT_FOUND",
    });
    expect(accounts.addMembership).not.toHaveBeenCalled();
  });

  it("AC8 — the membership is added only after the claim", async () => {
    const { d, accounts, inviteStore } = deps({}, [pendingRow()]);
    await acceptInvite(inviteeCtx(), { token: TOKEN }, d);
    expect(inviteStore.claim.mock.invocationCallOrder[0]).toBeLessThan(
      accounts.addMembership.mock.invocationCallOrder[0],
    );
  });

  it("a missing user is UNAUTHORIZED", async () => {
    const { d } = deps({}, [pendingRow()]);
    d.accounts = fakeAccounts(null);
    expect(await code(acceptInvite(inviteeCtx(), { token: TOKEN }, d))).toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("claimInvite (signup path)", () => {
  it("claims for a person with no memberships and hands back an undo", async () => {
    const row = pendingRow();
    const { d } = deps({}, [row]);
    const claimed = await claimInvite(
      TOKEN,
      { email: "fresh@example.test", memberships: [] },
      d,
    );
    expect(claimed).toMatchObject({ tenantId: TENANT, role: "member" });
    expect(row.acceptedAt).toEqual(NOW);
    await claimed.release();
    expect(row.acceptedAt).toBeNull();
  });
});

describe("previewInvite (AC7)", () => {
  it("returns workspace name and role, plus the email only when bound", async () => {
    const { d } = deps({}, [pendingRow()]);
    expect(await previewInvite(TOKEN, d)).toEqual({
      workspaceName: "Harbour Boats",
      role: "member",
    });
    const bound = deps({}, [pendingRow({ email: "new@example.test" })]);
    expect(await previewInvite(TOKEN, bound.d)).toEqual({
      workspaceName: "Harbour Boats",
      role: "member",
      email: "new@example.test",
    });
  });

  it("is NOT_FOUND for unknown, expired, revoked and accepted alike", async () => {
    for (const fields of [
      { expiresAt: new Date(NOW.getTime() - 1) },
      { revokedAt: NOW },
      { acceptedAt: NOW },
    ]) {
      const { d } = deps({}, [pendingRow(fields)]);
      expect(await code(previewInvite(TOKEN, d))).toMatchObject({ code: "NOT_FOUND" });
    }
    expect(await code(previewInvite("nope", deps().d))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not consume the invite", async () => {
    const row = pendingRow();
    await previewInvite(TOKEN, deps({}, [row]).d);
    expect(row.acceptedAt).toBeNull();
  });
});
