/**
 * The token service against a real MongoDB — the half tokens.test.ts stubs.
 *
 * Two things can only be proven here: that the Mongo store's `claim` really is
 * atomic (a filter on `usedAt: null`, not a read-then-write), and the
 * cross-tenant isolation the issue requires — a token minted for tenant A must
 * be refused on a tenant B resource.
 */
import { generateKeyPairSync } from "node:crypto";
import { ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildKeyring } from "@/server/auth/keys";
import { hashRefreshToken } from "@/server/auth/refresh-tokens";
import { ctxFromClaims } from "@/server/auth/session";
import { mongoIdentityStore, mongoRefreshStore, type DenyList } from "@/server/auth/stores";
import { getDb, getMongoClient } from "@/server/db/mongo";
import { createRepository } from "@/server/repositories/base";
import {
  issueSession,
  mintAccessToken,
  rotateSession,
  type TokenDeps,
} from "@/server/services/tokens";

const TENANT_A = "000000000000000000000001";
const TENANT_B = "000000000000000000000002";
const USER_A = "00000000000000000000000b";
const USER_B = "00000000000000000000000c";
const RECORD_B = new ObjectId("000000000000000000000044");

const pem = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const denied = new Set<string>();
const denyList: DenyList = {
  async deny(jti) {
    denied.add(jti);
  },
  async isDenied(jti) {
    return denied.has(jti);
  },
};

let mongod: MongoMemoryServer;
let deps: Partial<TokenDeps>;

type RecordDoc = { tenantId: ObjectId; data: { name: string }; deletedAt: Date | null };
const records = createRepository<RecordDoc>("records");

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ instance: { dbName: "graft_auth_it" } });
  process.env.MONGODB_URI = mongod.getUri("graft_auth_it");
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  process.env.APP_ENV = "qa";

  deps = {
    keyring: buildKeyring({ privateKey: pem.privateKey, publicKey: pem.publicKey }),
    refresh: mongoRefreshStore(),
    identity: mongoIdentityStore(),
    denyList,
  };

  const db = await getDb();
  await db.collection("tenants").insertMany([
    { _id: new ObjectId(TENANT_A), tier: "premium" },
    { _id: new ObjectId(TENANT_B), tier: "free" },
  ]);
  await db.collection("users").insertMany([
    {
      _id: new ObjectId(USER_A),
      memberships: [{ tenantId: new ObjectId(TENANT_A), roles: ["owner"] }],
    },
    {
      _id: new ObjectId(USER_B),
      memberships: [{ tenantId: new ObjectId(TENANT_B), roles: ["member"] }],
    },
  ]);
  // Tenant B's record — the thing tenant A's token must never reach.
  await db.collection("records").insertOne({
    _id: RECORD_B,
    tenantId: new ObjectId(TENANT_B),
    data: { name: "Do Not Leak" },
    deletedAt: null,
  });
});

afterAll(async () => {
  await (await getMongoClient()).close();
  await mongod.stop();
});

beforeEach(async () => {
  denied.clear();
  await (await getDb()).collection("refresh_tokens").deleteMany({});
});

const start = (tenantId = TENANT_A, userId = USER_A) =>
  issueSession(
    { tenantId, userId, roles: ["owner"], tier: tenantId === TENANT_A ? "premium" : "free" },
    deps,
  );

describe("refresh rotation against Mongo", () => {
  it("stores a hash and never the token itself", async () => {
    const session = await start();
    const stored = await (await getDb()).collection("refresh_tokens").findOne({});
    expect(stored?.tokenHash).toBe(hashRefreshToken(session.refreshToken));
    expect(JSON.stringify(stored)).not.toContain(session.refreshToken.split(".")[1]);
  });

  it("rotates, then refuses the token it rotated (AC2)", async () => {
    const first = await start();
    const second = await rotateSession(first.refreshToken, deps);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    await expect(rotateSession(first.refreshToken, deps)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  /** The reason `claim` is a findOneAndUpdate and not a read followed by a write. */
  it("lets exactly one of two concurrent rotations win (AC3)", async () => {
    const first = await start();
    const outcomes = await Promise.allSettled([
      rotateSession(first.refreshToken, deps),
      rotateSession(first.refreshToken, deps),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);

    const family = await (
      await getDb()
    )
      .collection("refresh_tokens")
      .find({ revokedAt: { $ne: null } })
      .toArray();
    expect(family.length).toBeGreaterThan(0);
  });

  it("revokes every token in the family on reuse, unspent ones included (AC3)", async () => {
    const first = await start();
    const second = await rotateSession(first.refreshToken, deps);
    await expect(rotateSession(first.refreshToken, deps)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(rotateSession(second.refreshToken, deps)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    const live = await (
      await getDb()
    )
      .collection("refresh_tokens")
      .countDocuments({ revokedAt: null });
    expect(live).toBe(0);
  });

  it("reads roles and tier live, so a revoked membership ends the session", async () => {
    const first = await start();
    const db = await getDb();
    await db
      .collection("users")
      .updateOne({ _id: new ObjectId(USER_A) }, { $set: { memberships: [] } });

    await expect(rotateSession(first.refreshToken, deps)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });

    await db
      .collection("users")
      .updateOne(
        { _id: new ObjectId(USER_A) },
        { $set: { memberships: [{ tenantId: new ObjectId(TENANT_A), roles: ["owner"] }] } },
      );
  });
});

describe("cross-tenant isolation", () => {
  /** The isolation test the issue's Test Contract requires. */
  it("refuses tenant A's token on a tenant B resource", async () => {
    const { claims } = mintAccessToken(
      { tenantId: TENANT_A, userId: USER_A, roles: ["owner"], tier: "premium" },
      deps,
    );
    const ctxA = ctxFromClaims(claims, "req-cross-tenant");
    expect(ctxA.tenantId).toBe(TENANT_A);

    // The repository injects ctx.tenantId, so B's record is simply not there.
    expect(await records.findById(ctxA, RECORD_B)).toBeNull();
    expect(await records.count(ctxA)).toBe(0);

    // ...and it is genuinely present for the tenant that owns it.
    const ctxB = ctxFromClaims(
      mintAccessToken(
        { tenantId: TENANT_B, userId: USER_B, roles: ["member"], tier: "free" },
        deps,
      ).claims,
      "req-cross-tenant",
    );
    expect((await records.findById(ctxB, RECORD_B))?.data.name).toBe("Do Not Leak");
  });

  it("refuses a refresh secret spent under another tenant's id", async () => {
    const mine = await start(TENANT_B, USER_B);
    const secret = mine.refreshToken.split(".")[1];

    await expect(rotateSession(`${TENANT_A}.${secret}`, deps)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    // The real owner's token is untouched by the attempt.
    expect((await rotateSession(mine.refreshToken, deps)).accessToken).toBeTruthy();
  });
});
