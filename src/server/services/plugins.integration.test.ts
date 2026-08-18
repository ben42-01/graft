/**
 * Plugin registry — integration coverage against a real MongoDB (GRAFT-14 AC1,
 * AC2, AC6, AC7).
 *
 * mongodb-memory-server rather than the QA docker stack, for the same reason
 * as records.integration.test.ts: CI runs `npm run test:integration` before
 * the QA stack exists. Exercises the real entities/forms/meters/entitlements
 * services together — nothing here is mocked — so this is the proof that
 * "through the normal APIs" (AC1) and "destroys no tenant data" (AC2) hold for
 * real writes, not just against a fake repository.
 */
import { ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import { getDb, getMongoClient } from "@/server/db/mongo";
import { TIER_LIMITS } from "@/server/tiers";
import { disablePlugin, enablePlugin, listPlugins } from "./plugins";

const TENANT_A = "000000000000000000000001";
const TENANT_B = "000000000000000000000002";
const USER = "00000000000000000000000b";

const ctxFor = (tenantId: string): Ctx =>
  createContext({
    requestId: `req-${tenantId}`,
    tenantId,
    userId: USER,
    roles: ["owner"],
    tier: "free",
  });

const ctxA = ctxFor(TENANT_A);
const ctxB = ctxFor(TENANT_B);

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ instance: { dbName: "graft_plugins_it" } });
  process.env.MONGODB_URI = mongod.getUri("graft_plugins_it");
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  process.env.APP_ENV = "qa";

  const db = await getDb();
  await db
    .collection("plugins_enabled")
    .createIndex({ tenantId: 1, pluginId: 1 }, { unique: true });
  await db.collection("entity_defs").createIndex({ tenantId: 1, key: 1 }, { unique: true });
  await db.collection("forms").createIndex({ tenantId: 1, slug: 1 }, { unique: true });
  await db
    .collection("usage_meters")
    .createIndex({ tenantId: 1, meter: 1, period: 1 }, { unique: true });
}, 60_000);

afterAll(async () => {
  await (await getMongoClient()).close();
  await mongod?.stop();
});

beforeEach(async () => {
  const db = await getDb();
  for (const name of ["tenants", "plugins_enabled", "entity_defs", "forms", "usage_meters"]) {
    await db.collection(name).deleteMany({});
  }
  await db.collection("tenants").insertMany([
    {
      _id: new ObjectId(TENANT_A),
      name: "Tenant A",
      slug: "tenant-a",
      tier: "free",
      limits: TIER_LIMITS.free,
      billingAnchorDay: 1,
      createdAt: new Date(),
    },
    {
      _id: new ObjectId(TENANT_B),
      name: "Tenant B",
      slug: "tenant-b",
      tier: "free",
      limits: TIER_LIMITS.free,
      billingAnchorDay: 1,
      createdAt: new Date(),
    },
  ]);
});

describe("enable → provision → disable → re-enable (AC1, AC2, AC7)", () => {
  it("provisions a real entity and form, and restores the same records on re-enable", async () => {
    const db = await getDb();

    const enabled = await enablePlugin(ctxA, "contacts");
    expect(enabled.enabled).toBe(true);

    const entity = await db
      .collection("entity_defs")
      .findOne({ tenantId: new ObjectId(TENANT_A), key: "contacts" });
    expect(entity).not.toBeNull();
    const form = await db
      .collection("forms")
      .findOne({ tenantId: new ObjectId(TENANT_A), slug: "contacts-form" });
    expect(form).not.toBeNull();
    expect(form!.entityDefId).toEqual(entity!._id);

    // AC2 — disabling hides capability but destroys nothing.
    const disabled = await disablePlugin(ctxA, "contacts");
    expect(disabled.enabled).toBe(false);
    expect(
      await db
        .collection("entity_defs")
        .findOne({ tenantId: new ObjectId(TENANT_A), key: "contacts" }),
    ).toMatchObject({ _id: entity!._id, deletedAt: null });
    expect(
      await db
        .collection("forms")
        .findOne({ tenantId: new ObjectId(TENANT_A), slug: "contacts-form" }),
    ).toMatchObject({ _id: form!._id });

    // AC2 — re-enabling restores access to the same records: same ids, no
    // duplicate entity_defs/forms rows, no error from the now-existing keys.
    const reEnabled = await enablePlugin(ctxA, "contacts");
    expect(reEnabled.enabled).toBe(true);
    expect(
      await db.collection("entity_defs").countDocuments({
        tenantId: new ObjectId(TENANT_A),
        key: "contacts",
      }),
    ).toBe(1);
    expect(
      await db
        .collection("entity_defs")
        .findOne({ tenantId: new ObjectId(TENANT_A), key: "contacts" }),
    ).toMatchObject({ _id: entity!._id });
  });

  it("activates all three MVP plugins cleanly on a fresh tenant (AC7)", async () => {
    for (const pluginId of ["contacts", "forms", "scheduling"]) {
      const view = await enablePlugin(ctxA, pluginId);
      expect(view.enabled).toBe(true);
    }
    const db = await getDb();
    const entityCount = await db
      .collection("entity_defs")
      .countDocuments({ tenantId: new ObjectId(TENANT_A) });
    const formCount = await db
      .collection("forms")
      .countDocuments({ tenantId: new ObjectId(TENANT_A) });
    expect(entityCount).toBe(3);
    expect(formCount).toBe(3);
  });
});

describe("tenant isolation (AC6)", () => {
  it("enabling a plugin for one tenant does not enable it, or provision anything, for another", async () => {
    await enablePlugin(ctxA, "contacts");

    const catalogueB = await listPlugins(ctxB);
    expect(catalogueB.find((p) => p.id === "contacts")?.enabled).toBe(false);

    const db = await getDb();
    expect(
      await db
        .collection("entity_defs")
        .findOne({ tenantId: new ObjectId(TENANT_B), key: "contacts" }),
    ).toBeNull();

    const catalogueA = await listPlugins(ctxA);
    expect(catalogueA.find((p) => p.id === "contacts")?.enabled).toBe(true);
  });
});
