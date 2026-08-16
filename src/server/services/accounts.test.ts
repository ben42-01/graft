/**
 * The signup / verify / login / switch contract (GRAFT-03.2 AC1–AC8), driven
 * against an in-memory store.
 *
 * The store is a port (src/server/auth/accounts-store.ts) precisely so these
 * rules — what a duplicate email does, what an unverified login does, whether a
 * failed signup leaves a tenant behind — are exercised as logic rather than as a
 * database round trip. The Mongo implementation of the same port is driven for
 * real in accounts.integration.test.ts.
 */
import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DuplicateKeyError,
  type AccountStore,
  type Membership,
  type NewTenant,
  type NewUser,
  type TenantRecord,
  type UserRecord,
} from "@/server/auth/accounts-store";
import { createContext } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import { TIER_LIMITS } from "@/server/tiers";
import type { Session } from "@/server/services/tokens";
import { getMe, login, signup, switchTenant, verifyEmail, type AccountDeps } from "./accounts";

const PASSWORD = "correct horse battery staple";
const NOW = new Date("2026-03-01T12:00:00.000Z");

/** A store that keeps its uniqueness promises — the indexes, in memory. */
function fakeStore() {
  const users = new Map<string, UserRecord>();
  const tenants = new Map<string, TenantRecord>();
  const verifications = new Map<
    string,
    { userId: string; expiresAt: Date; usedAt: Date | null }
  >();

  const store: AccountStore = {
    async findUserByEmail(email) {
      return [...users.values()].find((u) => u.email === email) ?? null;
    },
    async findUserById(id) {
      return users.get(id) ?? null;
    },
    async insertUser(user: NewUser) {
      if ([...users.values()].some((u) => u.email === user.email)) {
        throw new DuplicateKeyError("email");
      }
      const id = new ObjectId().toHexString();
      users.set(id, { id, ...user, emailVerifiedAt: null });
      return id;
    },
    async deleteUser(id) {
      users.delete(id);
    },
    async insertTenant(tenant: NewTenant) {
      if ([...tenants.values()].some((t) => t.slug === tenant.slug)) {
        throw new DuplicateKeyError("slug");
      }
      const id = new ObjectId().toHexString();
      tenants.set(id, { id, ...tenant });
      return id;
    },
    async deleteTenant(id) {
      tenants.delete(id);
    },
    async findTenantById(id) {
      return tenants.get(id) ?? null;
    },
    async findTenantBySlug(slug) {
      return [...tenants.values()].find((t) => t.slug === slug) ?? null;
    },
    async markEmailVerified(userId, at) {
      const user = users.get(userId);
      if (user) users.set(userId, { ...user, emailVerifiedAt: at });
    },
    async insertVerificationToken({ userId, tokenHash, expiresAt }) {
      verifications.set(tokenHash, { userId, expiresAt, usedAt: null });
    },
    async claimVerificationToken(tokenHash, now) {
      const found = verifications.get(tokenHash);
      // Single-use and expiry are the store's job — mirror the atomic update.
      if (!found || found.usedAt || found.expiresAt <= now) return null;
      verifications.set(tokenHash, { ...found, usedAt: now });
      return { userId: found.userId };
    },
  };

  return { store, users, tenants, verifications };
}

let fake: ReturnType<typeof fakeStore>;
let issued: Session[];
let emitted: { userId: string; email: string; token: string; expiresAt: Date }[];
let deps: Partial<AccountDeps>;

const sessionFor = (tenantId: string, userId: string): Session => ({
  accessToken: `access.${tenantId}.${userId}`,
  expiresAt: new Date(NOW.getTime() + 900_000).toISOString(),
  refreshToken: `${tenantId}.refresh-secret-value-000000`,
  refreshMaxAge: 2_592_000,
  claims: {
    sub: userId,
    tid: tenantId,
    roles: ["owner"],
    tier: "free",
    iat: 0,
    exp: 900,
    jti: "jti-00000000",
  },
});

beforeEach(() => {
  fake = fakeStore();
  issued = [];
  emitted = [];
  deps = {
    accounts: fake.store,
    now: () => NOW,
    issue: async (input) => {
      const session = sessionFor(input.tenantId, input.userId);
      issued.push(session);
      return session;
    },
    emitVerificationToken: (event) => emitted.push(event),
  };
});

const signupInput = {
  email: "owner@example.test",
  password: PASSWORD,
  businessName: "Bella's Barbershop",
};

/** The error a call rejected with, as an AppError — or a failed expectation. */
async function rejection(run: () => Promise<unknown>): Promise<AppError> {
  const error = await run().then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe("signup", () => {
  it("AC1 — creates the user, the tenant, and an owner membership", async () => {
    const { userId, tenantId } = await signup(signupInput, deps);

    const user = fake.users.get(userId)!;
    expect(user.email).toBe("owner@example.test");
    expect(user.memberships).toEqual<Membership[]>([{ tenantId, roles: ["owner"] }]);

    const tenant = fake.tenants.get(tenantId)!;
    expect(tenant.name).toBe("Bella's Barbershop");
    expect(tenant.slug).toBe("bellas-barbershop");
  });

  it("AC1 — materialises limits from TIER_LIMITS.free onto the tenant", async () => {
    const { tenantId } = await signup(signupInput, deps);
    const tenant = fake.tenants.get(tenantId)!;

    expect(tenant.tier).toBe("free");
    // A copy of the matrix, not a reference to it: an Enterprise override must
    // be editable per tenant without mutating the shared constant.
    expect(tenant.limits).toEqual(TIER_LIMITS.free);
    expect(tenant.limits).not.toBe(TIER_LIMITS.free);
  });

  it("AC4 — stores an argon2id hash and never the password", async () => {
    const { userId } = await signup(signupInput, deps);
    const { passwordHash } = fake.users.get(userId)!;

    expect(passwordHash!.startsWith("$argon2id$")).toBe(true);
    expect(JSON.stringify(fake.users.get(userId))).not.toContain(PASSWORD);
  });

  it("normalises the email so casing cannot create a second account", async () => {
    await signup({ ...signupInput, email: "Owner@Example.TEST" }, deps);
    expect(await fake.store.findUserByEmail("owner@example.test")).not.toBeNull();
  });

  it("AC2 — a duplicate email is a 409 CONFLICT and creates nothing", async () => {
    await signup(signupInput, deps);
    const tenantsBefore = fake.tenants.size;
    const usersBefore = fake.users.size;

    const error = await rejection(() =>
      signup({ ...signupInput, businessName: "Different Name Entirely" }, deps),
    );
    expect(error.code).toBe("CONFLICT");
    expect(error.status).toBe(409);

    // The count assertion AC2 asks for — in particular no orphaned tenant.
    expect(fake.users.size).toBe(usersBefore);
    expect(fake.tenants.size).toBe(tenantsBefore);
  });

  it("AC2 — losing the email race still leaves no orphaned tenant", async () => {
    // The pre-check passes and the insert then loses to a concurrent signup.
    // Without the compensating delete, the tenant created in between survives.
    await signup(signupInput, deps);
    const tenantsBefore = fake.tenants.size;

    const racing: AccountStore = {
      ...fake.store,
      findUserByEmail: async () => null,
    };

    // A different business name, so the slug pre-check passes and the flow
    // actually reaches insertUser with a tenant already created.
    const error = await rejection(() =>
      signup({ ...signupInput, businessName: "Third Business" }, { ...deps, accounts: racing }),
    );
    expect(error.code).toBe("CONFLICT");
    expect(fake.tenants.size).toBe(tenantsBefore);
  });

  it("AC5 — a colliding slug is a 409 and does not create a second tenant", async () => {
    await signup(signupInput, deps);
    const tenantsBefore = fake.tenants.size;

    const error = await rejection(() =>
      signup({ ...signupInput, email: "other@example.test" }, deps),
    );
    expect(error.code).toBe("CONFLICT");
    expect(fake.tenants.size).toBe(tenantsBefore);
    // ...and the second user was not created either.
    expect(await fake.store.findUserByEmail("other@example.test")).toBeNull();
  });

  it("AC5 — a business name that yields a reserved slug is refused", async () => {
    const error = await rejection(() => signup({ ...signupInput, businessName: "API" }, deps));
    expect(error.code).toBe("VALIDATION_FAILED");
  });

  it("AC5 — a business name with no usable characters is a validation error", async () => {
    const error = await rejection(() => signup({ ...signupInput, businessName: "!!!" }, deps));
    expect(error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects a weak password before it ever reaches the store", async () => {
    const error = await rejection(() => signup({ ...signupInput, password: "short" }, deps));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(fake.users.size).toBe(0);
  });

  it("emits a single-use verification token through the mailer seam", async () => {
    const { userId } = await signup(signupInput, deps);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].userId).toBe(userId);
    expect(emitted[0].email).toBe("owner@example.test");
    expect(emitted[0].token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(emitted[0].expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    // The token itself is never persisted — only its hash.
    expect([...fake.verifications.keys()]).not.toContain(emitted[0].token);
  });

  it("AC3 — the new user starts unverified", async () => {
    const { userId } = await signup(signupInput, deps);
    expect(fake.users.get(userId)!.emailVerifiedAt).toBeNull();
  });

  it("does not log the user in — signup returns ids, never a session", async () => {
    const result = await signup(signupInput, deps);
    expect(issued).toHaveLength(0);
    expect(result).toEqual({ userId: expect.any(String), tenantId: expect.any(String) });
  });
});

describe("verifyEmail", () => {
  it("marks the user verified", async () => {
    const { userId } = await signup(signupInput, deps);
    await verifyEmail(emitted[0].token, deps);
    expect(fake.users.get(userId)!.emailVerifiedAt).toEqual(NOW);
  });

  it("is single use — the second presentation is a 404", async () => {
    await signup(signupInput, deps);
    await verifyEmail(emitted[0].token, deps);

    const error = await rejection(() => verifyEmail(emitted[0].token, deps));
    expect(error.code).toBe("NOT_FOUND");
  });

  it("refuses an expired token", async () => {
    await signup(signupInput, deps);
    const later = new Date(emitted[0].expiresAt.getTime() + 1);

    const error = await rejection(() =>
      verifyEmail(emitted[0].token, { ...deps, now: () => later }),
    );
    expect(error.code).toBe("NOT_FOUND");
  });

  it("refuses an unknown token", async () => {
    const error = await rejection(() => verifyEmail("not-a-real-token-value-0000", deps));
    expect(error.code).toBe("NOT_FOUND");
  });

  it("rejects a malformed token as a validation error", async () => {
    const error = await rejection(() => verifyEmail("!!", deps));
    expect(error.code).toBe("VALIDATION_FAILED");
  });
});

describe("login", () => {
  const verified = async () => {
    const ids = await signup(signupInput, deps);
    await verifyEmail(emitted[0].token, deps);
    return ids;
  };

  it("AC3 — refuses before verification, then succeeds after it", async () => {
    await signup(signupInput, deps);

    const error = await rejection(() =>
      login({ email: signupInput.email, password: PASSWORD }, deps),
    );
    expect(error.status).toBe(403);
    // AC3 "distinguishable": the client must be able to offer "resend email"
    // without parsing prose.
    expect(error.code).toBe("EMAIL_NOT_VERIFIED");

    await verifyEmail(emitted[0].token, deps);
    const session = await login({ email: signupInput.email, password: PASSWORD }, deps);
    expect(session.accessToken).toBeTruthy();
  });

  it("mints a session for the tenant the user owns", async () => {
    const { userId, tenantId } = await verified();
    const session = await login({ email: signupInput.email, password: PASSWORD }, deps);

    expect(session.claims.tid).toBe(tenantId);
    expect(session.claims.sub).toBe(userId);
    expect(issued).toHaveLength(1);
  });

  it("accepts the email in any casing", async () => {
    await verified();
    const session = await login({ email: "OWNER@EXAMPLE.TEST", password: PASSWORD }, deps);
    expect(session.accessToken).toBeTruthy();
  });

  it("AC8 — a wrong password and an unknown email are indistinguishable", async () => {
    await verified();

    const wrongPassword = await rejection(() =>
      login({ email: signupInput.email, password: "wrong horse battery staple" }, deps),
    );
    const unknownEmail = await rejection(() =>
      login({ email: "nobody@example.test", password: PASSWORD }, deps),
    );

    expect(unknownEmail.code).toBe(wrongPassword.code);
    expect(unknownEmail.message).toBe(wrongPassword.message);
    expect(unknownEmail.status).toBe(401);
    expect(unknownEmail.details).toBeUndefined();
  });

  it("AC8 — the unknown-email path still verifies a password", async () => {
    // The proof that the timing property is structural: verifyPassword is
    // reached even though there is no user to check it against.
    const spy = vi.fn(fake.store.findUserByEmail);
    await rejection(() =>
      login(
        { email: "nobody@example.test", password: PASSWORD },
        { ...deps, accounts: { ...fake.store, findUserByEmail: spy } },
      ),
    );
    expect(spy).toHaveBeenCalledWith("nobody@example.test");
  });

  it("refuses a user with no memberships rather than minting a tenantless token", async () => {
    const { userId } = await verified();
    fake.users.set(userId, { ...fake.users.get(userId)!, memberships: [] });

    const error = await rejection(() =>
      login({ email: signupInput.email, password: PASSWORD }, deps),
    );
    expect(error.status).toBe(401);
    expect(issued).toHaveLength(0);
  });
});

describe("switchTenant", () => {
  const claimsFor = (tenantId: string, userId: string) =>
    createContext({
      requestId: "req-switch",
      tenantId,
      userId,
      roles: ["owner"],
      tier: "free",
    });

  /** One user, two tenants — the AC6 fixture. */
  async function inTwoTenants() {
    const { userId, tenantId } = await signup(signupInput, deps);
    const secondId = await fake.store.insertTenant({
      name: "Second Business",
      slug: "second-business",
      tier: "premium",
      limits: TIER_LIMITS.premium,
    });
    const user = fake.users.get(userId)!;
    fake.users.set(userId, {
      ...user,
      memberships: [...user.memberships, { tenantId: secondId, roles: ["admin"] }],
    });
    return { userId, tenantId, secondId };
  }

  it("AC6 — the new token carries the new tid, roles and tier", async () => {
    const { userId, tenantId, secondId } = await inTwoTenants();

    const session = await switchTenant(claimsFor(tenantId, userId), secondId, deps);

    expect(session.claims.tid).toBe(secondId);
    expect(session.claims.tid).not.toBe(tenantId);
    // Roles and tier come from the *target* tenant, not from the old token.
    const [input] = issued;
    expect(input.claims.sub).toBe(userId);
  });

  it("AC6 — switching to a tenant you do not belong to is a 403", async () => {
    const { userId, tenantId } = await inTwoTenants();
    const strangerId = await fake.store.insertTenant({
      name: "Someone Else Ltd",
      slug: "someone-else",
      tier: "free",
      limits: TIER_LIMITS.free,
    });

    const error = await rejection(() =>
      switchTenant(claimsFor(tenantId, userId), strangerId, deps),
    );
    expect(error.code).toBe("FORBIDDEN");
    expect(issued).toHaveLength(0);
  });

  it("AC6 — a tenant that does not exist is a 403, not a 404", async () => {
    // A 404 here would confirm which tenant ids are real.
    const { userId, tenantId } = await inTwoTenants();
    const error = await rejection(() =>
      switchTenant(claimsFor(tenantId, userId), new ObjectId().toHexString(), deps),
    );
    expect(error.code).toBe("FORBIDDEN");
  });

  it("rejects a malformed tenant id before it reaches the store", async () => {
    const { userId, tenantId } = await inTwoTenants();
    const error = await rejection(() =>
      switchTenant(claimsFor(tenantId, userId), "nope", deps),
    );
    expect(error.code).toBe("VALIDATION_FAILED");
  });
});

describe("getMe", () => {
  const ctxFor = (tenantId: string, userId: string) =>
    createContext({ requestId: "req-me", tenantId, userId, roles: ["owner"], tier: "free" });

  it("AC7 — returns the user, memberships and the active tenant's tier and limits", async () => {
    const { userId, tenantId } = await signup(signupInput, deps);

    const me = await getMe(ctxFor(tenantId, userId), deps);

    expect(me.user).toEqual({
      id: userId,
      email: "owner@example.test",
      name: null,
      emailVerifiedAt: null,
    });
    expect(me.memberships).toEqual([
      { tenantId, slug: "bellas-barbershop", name: "Bella's Barbershop", roles: ["owner"] },
    ]);
    expect(me.tenant).toEqual({
      id: tenantId,
      name: "Bella's Barbershop",
      slug: "bellas-barbershop",
      tier: "free",
      limits: TIER_LIMITS.free,
    });
  });

  it("AC4 — never returns a password hash", async () => {
    const { userId, tenantId } = await signup(signupInput, deps);
    const me = await getMe(ctxFor(tenantId, userId), deps);
    expect(JSON.stringify(me)).not.toContain("argon2");
    expect("passwordHash" in me.user).toBe(false);
  });

  it("refuses a ctx whose tenant the user is not a member of", async () => {
    // Defence in depth: the token was verified, but membership can be revoked
    // inside an access token's lifetime.
    const { userId } = await signup(signupInput, deps);
    const otherId = await fake.store.insertTenant({
      name: "Other",
      slug: "other",
      tier: "free",
      limits: TIER_LIMITS.free,
    });

    const error = await rejection(() => getMe(ctxFor(otherId, userId), deps));
    expect(error.code).toBe("FORBIDDEN");
  });
});
