/**
 * The onboarding flow end to end, against a real MongoDB: signup → verify →
 * login → me, plus the two uniqueness rules that only a real unique index can
 * actually prove (AC2, AC5).
 *
 * mongodb-memory-server rather than the QA docker stack, for the same reason
 * base.integration.test.ts gives: CI runs `npm run test:integration` before the
 * stack is up (.github/workflows/ci.yml), and a proof that only runs on a
 * developer's laptop is not a proof.
 *
 * Session minting is injected. Signing a real RS256 token needs a keyring and a
 * live Redis deny-list, both of which are GRAFT-03.1's contract and are already
 * proven there — what is under test here is the account layer beneath it.
 */
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mongoAccountStore, VERIFICATION_COLLECTION } from "@/server/auth/accounts-store";
import { createContext } from "@/server/context";
import { getDb, getMongoClient } from "@/server/db/mongo";
import { AppError } from "@/server/http/envelope";
import { TIER_LIMITS } from "@/server/tiers";
import type { AccessTokenInput, Session } from "@/server/services/tokens";
import {
  getMe,
  login,
  signup,
  switchTenant,
  verifyEmail,
  type AccountDeps,
  type VerificationIssued,
} from "./accounts";

const PASSWORD = "integration-test-password";

let mongod: MongoMemoryServer;
let emitted: VerificationIssued[];
let deps: Partial<AccountDeps>;

/** A stand-in for issueSession — enough to assert what was minted, and for whom. */
const fakeIssue = async (input: AccessTokenInput): Promise<Session> => ({
  accessToken: "access-token",
  expiresAt: new Date(Date.now() + 900_000).toISOString(),
  refreshToken: `${input.tenantId}.refresh`,
  refreshMaxAge: 2_592_000,
  claims: {
    sub: input.userId,
    tid: input.tenantId,
    roles: [...input.roles],
    tier: input.tier,
    iat: 0,
    exp: 900,
    jti: "jti-integration",
  },
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ instance: { dbName: "graft_accounts_it" } });
  process.env.MONGODB_URI = mongod.getUri("graft_accounts_it");
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  process.env.APP_ENV = "qa";

  const db = await getDb();
  // The uniqueness rules under test are indexes, not application code — without
  // these the AC2/AC5 assertions below would pass for the wrong reason.
  await db.collection("users").createIndex({ email: 1 }, { unique: true });
  await db.collection("tenants").createIndex({ slug: 1 }, { unique: true });
  await db.collection(VERIFICATION_COLLECTION).createIndex({ tokenHash: 1 }, { unique: true });
}, 60_000);

afterAll(async () => {
  await (await getMongoClient()).close();
  await mongod?.stop();
});

beforeEach(async () => {
  const db = await getDb();
  for (const name of ["users", "tenants", VERIFICATION_COLLECTION]) {
    await db.collection(name).deleteMany({});
  }
  emitted = [];
  deps = { issue: fakeIssue, emitVerificationToken: (event) => emitted.push(event) };
});

const signupInput = {
  email: "owner@integration.test",
  password: PASSWORD,
  businessName: "Integration Motors",
};

async function rejection(run: () => Promise<unknown>): Promise<AppError> {
  const error = await run().then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe("signup → verify → login → me", () => {
  it("completes the whole onboarding flow", async () => {
    const { userId, tenantId } = await signup(signupInput, deps);

    // AC1 — the documents are really there, shaped as the rest of the app reads them.
    const db = await getDb();
    const tenant = await db.collection("tenants").findOne({ _id: new ObjectId(tenantId) });
    expect(tenant).toMatchObject({
      name: "Integration Motors",
      slug: "integration-motors",
      tier: "free",
      limits: TIER_LIMITS.free,
    });

    const user = await db.collection("users").findOne({ _id: new ObjectId(userId) });
    expect(user!.email).toBe("owner@integration.test");
    expect(user!.memberships).toEqual([{ tenantId: new ObjectId(tenantId), roles: ["owner"] }]);
    // AC4 — argon2id in the database, and the password itself nowhere in it.
    expect(user!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(user)).not.toContain(PASSWORD);

    // AC3 — login is refused until the token is spent.
    const before = await rejection(() =>
      login({ email: signupInput.email, password: PASSWORD }, deps),
    );
    expect(before.code).toBe("EMAIL_NOT_VERIFIED");
    expect(before.status).toBe(403);

    await verifyEmail(emitted[0].token, deps);
    expect(
      (await db.collection("users").findOne({ _id: new ObjectId(userId) }))!.emailVerifiedAt,
    ).toBeInstanceOf(Date);

    // ...and now it succeeds, for the tenant signup created.
    const session = await login({ email: signupInput.email, password: PASSWORD }, deps);
    expect(session.claims.tid).toBe(tenantId);
    expect(session.claims.roles).toEqual(["owner"]);

    // AC7 — the entitlement object the UI reads.
    const ctx = createContext({
      requestId: "req-it",
      tenantId,
      userId,
      roles: ["owner"],
      tier: "free",
    });
    const me = await getMe(ctx, deps);
    expect(me.user.email).toBe("owner@integration.test");
    expect(me.tenant).toEqual({
      id: tenantId,
      name: "Integration Motors",
      slug: "integration-motors",
      tier: "free",
      limits: TIER_LIMITS.free,
      branding: null,
    });
    expect(me.memberships).toEqual([
      {
        tenantId,
        slug: "integration-motors",
        name: "Integration Motors",
        roles: ["owner"],
      },
    ]);
    expect(JSON.stringify(me)).not.toContain("argon2");
  });

  it("AC3 — a verification token cannot be spent twice, against a real index", async () => {
    await signup(signupInput, deps);
    await verifyEmail(emitted[0].token, deps);

    const error = await rejection(() => verifyEmail(emitted[0].token, deps));
    expect(error.code).toBe("NOT_FOUND");

    // The claim is recorded, not merely returned.
    const db = await getDb();
    const token = await db.collection(VERIFICATION_COLLECTION).findOne({});
    expect(token!.usedAt).toBeInstanceOf(Date);
  });
});

describe("uniqueness", () => {
  it("AC2 — a duplicate email is a 409 and leaves no extra documents", async () => {
    await signup(signupInput, deps);
    const db = await getDb();

    const error = await rejection(() =>
      signup({ ...signupInput, businessName: "Some Other Garage" }, deps),
    );
    expect(error.code).toBe("CONFLICT");

    // The count assertion AC2 asks for.
    expect(await db.collection("users").countDocuments()).toBe(1);
    expect(await db.collection("tenants").countDocuments()).toBe(1);
  });

  it("AC5 — a colliding slug is a 409 and does not create a second tenant", async () => {
    await signup(signupInput, deps);
    const db = await getDb();

    const error = await rejection(() =>
      signup({ ...signupInput, email: "other@integration.test" }, deps),
    );
    expect(error.code).toBe("CONFLICT");

    expect(await db.collection("tenants").countDocuments()).toBe(1);
    expect(await db.collection("users").countDocuments()).toBe(1);
  });

  it("AC2 — the unique index, not the pre-check, is what finally decides", async () => {
    // Both signups pass their pre-checks before either inserts. Only the index
    // can separate them, and the loser must still leave no orphaned tenant.
    const results = await Promise.allSettled([
      signup({ ...signupInput, businessName: "Race One" }, deps),
      signup({ ...signupInput, businessName: "Race Two" }, deps),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const db = await getDb();
    expect(await db.collection("users").countDocuments()).toBe(1);
    expect(await db.collection("tenants").countDocuments()).toBe(1);
  });
});

describe("tenant isolation", () => {
  it("AC6 — a user cannot switch into a tenant they are not a member of", async () => {
    const { userId, tenantId } = await signup(signupInput, deps);
    const strangerId = await mongoAccountStore().insertTenant({
      name: "Someone Else Ltd",
      slug: "someone-else",
      tier: "premium",
      limits: TIER_LIMITS.premium,
    });

    const ctx = createContext({
      requestId: "req-switch",
      tenantId,
      userId,
      roles: ["owner"],
      tier: "free",
    });

    const error = await rejection(() => switchTenant(ctx, strangerId, deps));
    expect(error.code).toBe("FORBIDDEN");
    expect(error.status).toBe(403);
  });

  it("AC6 — a real membership switches, and the new token names the new tenant", async () => {
    const { userId, tenantId } = await signup(signupInput, deps);
    const store = mongoAccountStore();
    const secondId = await store.insertTenant({
      name: "Second Workspace",
      slug: "second-workspace",
      tier: "premium",
      limits: TIER_LIMITS.premium,
    });
    // Typed so `$push` resolves against a known array field rather than the
    // driver's catch-all Document signature, which accepts no element type.
    type UserDoc = { memberships: { tenantId: ObjectId; roles: string[] }[] };
    await (
      await getDb()
    )
      .collection<UserDoc>("users")
      .updateOne(
        { _id: new ObjectId(userId) },
        { $push: { memberships: { tenantId: new ObjectId(secondId), roles: ["admin"] } } },
      );

    const ctx = createContext({
      requestId: "req-switch",
      tenantId,
      userId,
      roles: ["owner"],
      tier: "free",
    });

    const session = await switchTenant(ctx, secondId, deps);
    expect(session.claims.tid).toBe(secondId);
    expect(session.claims.roles).toEqual(["admin"]);
    // Tier follows the tenant, so entitlements change with the switch.
    expect(session.claims.tier).toBe("premium");
  });

  it("AC7 — /me refuses a ctx whose tenant the user has no membership in", async () => {
    const { userId } = await signup(signupInput, deps);
    const strangerId = await mongoAccountStore().insertTenant({
      name: "Not Yours",
      slug: "not-yours",
      tier: "free",
      limits: TIER_LIMITS.free,
    });

    const ctx = createContext({
      requestId: "req-me",
      tenantId: strangerId,
      userId,
      roles: ["owner"],
      tier: "free",
    });

    const error = await rejection(() => getMe(ctx, deps));
    expect(error.code).toBe("FORBIDDEN");
  });
});

describe("password storage", () => {
  it("AC8 — an unknown email and a wrong password give the identical error", async () => {
    await signup(signupInput, deps);
    await verifyEmail(emitted[0].token, deps);

    const wrong = await rejection(() =>
      login({ email: signupInput.email, password: "not-the-password" }, deps),
    );
    const unknown = await rejection(() =>
      login({ email: "nobody@integration.test", password: PASSWORD }, deps),
    );

    expect(unknown.code).toBe(wrong.code);
    expect(unknown.status).toBe(401);
    expect(unknown.message).toBe(wrong.message);
  });

  it("AC4 — the stored hash verifies through the real driver round trip", async () => {
    await signup(signupInput, deps);
    await verifyEmail(emitted[0].token, deps);

    // Proves the digest survives BSON storage and retrieval intact — a subtly
    // mangled string would still look like a hash but never match.
    const session = await login({ email: signupInput.email, password: PASSWORD }, deps);
    expect(session.claims.sub).toBeTruthy();
  });
});

/** Guards the assumption the whole suite rests on. */
it("connects to a real mongod", async () => {
  expect(await (await getDb()).admin().ping()).toMatchObject({ ok: 1 });
  expect(mongod.getUri()).toContain("mongodb://");
  expect(MongoClient).toBeTruthy();
});
