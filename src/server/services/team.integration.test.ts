/**
 * Accepting an invite against a real MongoDB replica set (GRAFT-33.2 AC8, and
 * the cross-tenant rule): the atomic claim, the compensating undo, and that a
 * membership is never added twice — none of which a fake store can prove.
 *
 * mongodb-memory-server rather than the QA stack, for the reason
 * accounts.integration.test.ts gives: CI runs this before the stack is up.
 */
import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mongoAccountStore } from "@/server/auth/accounts-store";
import { getDb, getMongoClient } from "@/server/db/mongo";
import { AppError } from "@/server/http/envelope";
import { createContext } from "@/server/context";
import { TIER_LIMITS } from "@/server/tiers";
import { acceptInvite, type InviteDoc, type TeamDeps } from "./team";

let mongod: MongoMemoryReplSet;

const TENANT_A = new ObjectId();
const TENANT_B = new ObjectId();
const OWNER = new ObjectId();
const INVITEE = new ObjectId();
const TOKEN = "a".repeat(43);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const ctx = () =>
  createContext({
    requestId: "req-team-it",
    tenantId: TENANT_B.toHexString(),
    userId: INVITEE.toHexString(),
    roles: ["owner"],
    tier: "premium",
  });

/** Entitlements are not under test here; a roomy plan keeps seats out of it. */
const roomy: Partial<TeamDeps> = {
  entitlements: async () =>
    ({ tenantId: TENANT_A.toHexString(), limits: { seats: 15 } }) as never,
};

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = mongod.getUri("graft_team_it");
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  process.env.APP_ENV = "qa";
  const db = await getDb();
  await db.collection("invites").createIndex({ tokenHash: 1 }, { unique: true });
}, 60_000);

afterAll(async () => {
  await (await getMongoClient()).close();
  await mongod?.stop();
});

beforeEach(async () => {
  const db = await getDb();
  for (const name of ["users", "tenants", "invites"]) await db.collection(name).deleteMany({});
  const now = new Date();
  await db.collection("tenants").insertMany([
    {
      _id: TENANT_A,
      name: "Harbour Boats",
      slug: "harbour-boats",
      tier: "premium",
      limits: TIER_LIMITS.premium,
    },
    {
      _id: TENANT_B,
      name: "Other Co",
      slug: "other-co",
      tier: "premium",
      limits: TIER_LIMITS.premium,
    },
  ] as never);
  await db.collection("users").insertMany([
    {
      _id: OWNER,
      email: "owner@example.test",
      memberships: [{ tenantId: TENANT_A, roles: ["owner"] }],
    },
    {
      _id: INVITEE,
      email: "invitee@example.test",
      memberships: [{ tenantId: TENANT_B, roles: ["owner"] }],
    },
  ] as never);
  await db.collection<InviteDoc>("invites").insertOne({
    tenantId: TENANT_A,
    role: "member",
    email: null,
    tokenHash: sha(TOKEN),
    createdBy: OWNER,
    createdAt: now,
    expiresAt: new Date(now.getTime() + 86_400_000),
    acceptedAt: null,
    revokedAt: null,
  });
});

const invite = async () =>
  (await getDb()).collection("invites").findOne({ tokenHash: sha(TOKEN) });
const memberships = async () =>
  (await (await getDb()).collection("users").findOne({ _id: INVITEE }))!.memberships as {
    tenantId: ObjectId;
    roles: string[];
  }[];

describe("acceptInvite on a real database", () => {
  it("adds only the invite's tenant, leaves the user's other workspace alone, and marks it accepted", async () => {
    const result = await acceptInvite(ctx(), { token: TOKEN }, roomy);
    expect(result).toEqual({
      tenantId: TENANT_A.toHexString(),
      tenantSlug: "harbour-boats",
      role: "member",
    });
    const list = await memberships();
    expect(list.map((m) => m.tenantId.toHexString()).sort()).toEqual(
      [TENANT_A, TENANT_B].map((t) => t.toHexString()).sort(),
    );
    expect(list.find((m) => m.tenantId.equals(TENANT_B))!.roles).toEqual(["owner"]);
    expect((await invite())!.acceptedAt).toBeInstanceOf(Date);
  });

  it("AC8 — two simultaneous accepts of one link: exactly one wins", async () => {
    const results = await Promise.allSettled([
      acceptInvite(ctx(), { token: TOKEN }, roomy),
      acceptInvite(ctx(), { token: TOKEN }, roomy),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(AppError);
    expect((await memberships()).filter((m) => m.tenantId.equals(TENANT_A))).toHaveLength(1);
  });

  it("AC8 — a failing membership write puts the invite back to pending", async () => {
    const real = mongoAccountStore();
    const accounts = {
      ...real,
      addMembership: async () => {
        throw new Error("write failed");
      },
    };
    await expect(acceptInvite(ctx(), { token: TOKEN }, { ...roomy, accounts })).rejects.toThrow(
      "write failed",
    );
    expect((await invite())!.acceptedAt).toBeNull();
    expect((await memberships()).some((m) => m.tenantId.equals(TENANT_A))).toBe(false);
    // ...and the same link then works.
    await acceptInvite(ctx(), { token: TOKEN }, roomy);
    expect((await memberships()).some((m) => m.tenantId.equals(TENANT_A))).toBe(true);
  });

  it("addMembership never duplicates or rewrites an existing membership", async () => {
    const store = mongoAccountStore();
    expect(
      await store.addMembership(INVITEE.toHexString(), TENANT_B.toHexString(), ["member"]),
    ).toBe(false);
    expect((await memberships()).find((m) => m.tenantId.equals(TENANT_B))!.roles).toEqual([
      "owner",
    ]);
  });
});
