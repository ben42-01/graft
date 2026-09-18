/**
 * GRAFT-27.2 — the admin tenant list against a real MongoDB.
 *
 * "The list spans tenants" is a claim about the database, so it is asserted
 * where the database is: real documents in a real `tenants` collection, read
 * through `mongoAdminTenantStore` with no `ctx` anywhere in the call.
 * mongodb-memory-server rather than the QA docker stack, for the same reason
 * as billing.integration.test.ts — CI runs `test:integration` before the QA
 * stack is up, and a proof that only runs locally is not a proof.
 */
import { ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getMongoClient } from "@/server/db/mongo";
import { TIER_LIMITS } from "@/server/tiers";
import { getAdminTenant, listAdminTenants, mongoAdminTenantStore } from "./admin-tenants";

const oid = (n: number) => new ObjectId(String(n).padStart(24, "0"));

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ instance: { dbName: "graft_admin_tenants" } });
  process.env.MONGODB_URI = mongod.getUri("graft_admin_tenants");
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  process.env.APP_ENV = "qa";
  await getDb();
}, 120_000);

afterAll(async () => {
  await (await getMongoClient()).close();
  await mongod?.stop();
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection("tenants").deleteMany({});
  await db.collection("tenants").insertMany([
    {
      _id: oid(1),
      name: "Acme Free",
      slug: "acme-free",
      tier: "free",
      limits: TIER_LIMITS.free,
      billingAnchorDay: 1,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    {
      _id: oid(2),
      name: "Acme Premium",
      slug: "acme-premium",
      tier: "premium",
      limits: TIER_LIMITS.premium,
      billingAnchorDay: 1,
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
      billing: {
        stripeCustomerId: "cus_integration",
        stripeSubscriptionId: "sub_integration",
        graceExpiresAt: null,
        trialEndsAt: null,
      },
    },
    {
      _id: oid(3),
      name: "Beta Downgraded",
      slug: "beta-downgraded",
      tier: "free",
      limits: { seats: 1 },
      readOnly: ["records", "entities"],
      downgradedAt: new Date("2026-02-02T00:00:00.000Z"),
      billingAnchorDay: 7,
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
    },
  ]);
});

const store = () => mongoAdminTenantStore();

describe("the admin list spans every tenant", () => {
  it("returns tenants the caller holds no membership in (AC1)", async () => {
    const page = await listAdminTenants({}, { store: store() });
    expect(page.items.map((t) => t.slug).sort()).toEqual([
      "acme-free",
      "acme-premium",
      "beta-downgraded",
    ]);
  });

  it("pages across the collection without repeating or dropping a tenant (AC2)", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listAdminTenants(
        { limit: "1", ...(cursor ? { cursor } : {}) },
        { store: store() },
      );
      expect(page.items).toHaveLength(1);
      seen.push(...page.items.map((t) => t.id));
      cursor = page.meta.cursor;
    } while (cursor);
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  it("searches name and slug case-insensitively, with the term escaped (AC3)", async () => {
    const byName = await listAdminTenants({ q: "acme" }, { store: store() });
    expect(byName.items.map((t) => t.slug).sort()).toEqual(["acme-free", "acme-premium"]);

    const bySlug = await listAdminTenants({ q: "BETA-DOWN" }, { store: store() });
    expect(bySlug.items.map((t) => t.slug)).toEqual(["beta-downgraded"]);

    // A wildcard reaches Mongo as text and therefore matches nothing.
    for (const hostile of [".*", "$ne", ".+"]) {
      const page = await listAdminTenants({ q: hostile }, { store: store() });
      expect(page.items).toHaveLength(0);
    }
  });

  it("filters by tier (AC4)", async () => {
    const page = await listAdminTenants({ tier: "premium" }, { store: store() });
    expect(page.items.map((t) => t.slug)).toEqual(["acme-premium"]);
  });

  it("never emits a Stripe id from a document that has one (AC8)", async () => {
    const page = await listAdminTenants({}, { store: store() });
    const serialised = JSON.stringify(page.items);
    expect(serialised).not.toContain("cus_");
    expect(serialised).not.toContain("sub_");
    const premium = page.items.find((t) => t.slug === "acme-premium");
    expect(premium?.billing).toEqual({
      hasCustomer: true,
      hasSubscription: true,
      graceExpiresAt: null,
      trialEndsAt: null,
    });
  });
});

describe("the admin detail read", () => {
  it("resolves entitlements over the override bag (AC5)", async () => {
    const detail = await getAdminTenant(oid(3).toHexString(), { store: store() });
    expect(detail.slug).toBe("beta-downgraded");
    expect(detail.limits.limits.seats).toBe(1);
    expect(detail.limitOverrides).toEqual({ seats: 1 });
    expect(detail.readOnly).toEqual(["records", "entities"]);
    expect(detail.downgradedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(detail.billingAnchorDay).toBe(7);
  });

  it("raises NOT_FOUND for well-formed hex naming no tenant (AC6)", async () => {
    await expect(
      getAdminTenant(oid(99).toHexString(), { store: store() }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("raises VALIDATION_FAILED, not a driver error, for a bad id (AC6)", async () => {
    await expect(getAdminTenant("not-hex", { store: store() })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});
