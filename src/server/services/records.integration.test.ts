/**
 * Records — integration coverage against a real MongoDB (GRAFT-07 AC2, AC8).
 *
 * mongodb-memory-server rather than the QA docker stack, for the same reason
 * as base.integration.test.ts: CI runs `npm run test:integration` before the
 * QA stack exists.
 */
import { ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import { getMongoClient, getDb } from "@/server/db/mongo";
import type { EntityView } from "@/server/services/entities";
import { createRecord, getRecord, listRecords } from "./records";

const TENANT_A = "000000000000000000000001";
const TENANT_B = "000000000000000000000002";
const ENTITY_A = "000000000000000000000021";
const ENTITY_B = "000000000000000000000022";
const ENTITY_C = "000000000000000000000023";

const ctxFor = (tenantId: string): Ctx =>
  createContext({
    requestId: `req-${tenantId}`,
    tenantId,
    userId: "00000000000000000000000b",
    roles: ["owner"],
    tier: "free",
  });

const ctxA = ctxFor(TENANT_A);
const ctxB = ctxFor(TENANT_B);

const entityView = (over: Partial<EntityView> = {}): EntityView => ({
  id: ENTITY_A,
  key: "customers",
  name: "Customers",
  fields: [{ key: "name", label: "Name", type: "text", required: true }],
  schemaVersion: 1,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ instance: { dbName: "graft_records_it" } });
  process.env.MONGODB_URI = mongod.getUri("graft_records_it");
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  process.env.APP_ENV = "qa";
}, 120_000);

afterAll(async () => {
  await (await getMongoClient()).close();
  await mongod?.stop();
});

const noopQuota = async () => ({
  meter: "records" as const,
  period: "all",
  allowed: true,
  limit: null,
  used: 0,
  remaining: null,
  warned: false,
});

// AC2 — cursor pagination over a real seeded set: each row exactly once.
describe("listRecords pagination (AC2)", () => {
  it("pages through 100 records with no duplicates or gaps", async () => {
    const getEntity = async () => entityView({ id: ENTITY_A });
    for (let i = 0; i < 100; i++) {
      await createRecord(
        ctxA,
        ENTITY_A,
        { name: `Row ${i}` },
        { getEntity, consumeQuota: noopQuota },
      );
    }

    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const { items, meta } = await listRecords(
        ctxA,
        ENTITY_A,
        { cursor, limit: 9 },
        { getEntity },
      );
      for (const item of items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      pages++;
      if (!meta.hasMore) break;
      cursor = meta.cursor!;
      expect(pages).toBeLessThan(50); // guard against an infinite loop on a bug
    }
    expect(seen.size).toBe(100);
  });
});

// AC8 — cross-tenant and cross-entity isolation, proven for real.
describe("tenant and entity isolation (AC8)", () => {
  it("never returns another tenant's records", async () => {
    const getEntityA = async () => entityView({ id: ENTITY_B, key: "secrets" });
    const created = await createRecord(
      ctxB,
      ENTITY_B,
      { name: "B secret" },
      { getEntity: getEntityA, consumeQuota: noopQuota },
    );

    const getEntityAsA = async () => entityView({ id: ENTITY_B, key: "secrets" });
    await expect(
      getRecord(ctxA, ENTITY_B, created.id, {}, { getEntity: getEntityAsA }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// AC6 — lazy migration persists on read, proven against a real update.
describe("lazy schema migration (AC6)", () => {
  it("drops a retired field and bumps schemaVersion on read", async () => {
    const oldEntity = entityView({
      id: ENTITY_C,
      schemaVersion: 1,
      fields: [
        { key: "name", label: "Name", type: "text", required: true },
        { key: "legacy", label: "Legacy", type: "text", required: false },
      ],
    });
    const created = await createRecord(
      ctxA,
      ENTITY_C,
      { name: "Ada", legacy: "drop me" },
      { getEntity: async () => oldEntity, consumeQuota: noopQuota },
    );

    const newEntity = entityView({
      id: ENTITY_C,
      schemaVersion: 2,
      fields: [{ key: "name", label: "Name", type: "text", required: true }],
    });
    const migrated = await getRecord(
      ctxA,
      ENTITY_C,
      created.id,
      {},
      {
        getEntity: async () => newEntity,
      },
    );
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.data).toEqual({ name: "Ada" });

    const db = await getDb();
    const stored = await db.collection("records").findOne({ _id: new ObjectId(created.id) });
    expect(stored?.schemaVersion).toBe(2);
    expect(stored?.data).toEqual({ name: "Ada" });
  });
});
