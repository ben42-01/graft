/**
 * The tenant-isolation guarantee, proven against a real MongoDB.
 *
 * docs/BACKEND.md §7.1 puts repositories and tenant isolation in the integration
 * layer, on "Vitest + mongodb-memory-server (or Testcontainers)". The in-memory
 * server is used rather than the QA docker stack because CI runs
 * `npm run test:integration` before the stack is up (.github/workflows/ci.yml),
 * and an isolation proof that only runs on a developer's laptop is not a proof.
 */
import { ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContext } from "@/server/context";
import { getMongoClient, getDb } from "@/server/db/mongo";
import { decodeCursor } from "@/server/http/pagination";
import { TenantScopeError, createRepository, type TenantDoc } from "./base";

const TENANT_A = "000000000000000000000001";
const TENANT_B = "000000000000000000000002";
const ENTITY = new ObjectId("000000000000000000000021");
const oid = (n: number) => new ObjectId(n.toString(16).padStart(24, "0"));

type RecordDoc = {
  tenantId: ObjectId;
  entityDefId: ObjectId;
  data: { name: string };
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const ctxFor = (tenantId: string) =>
  createContext({
    requestId: `req-${tenantId}`,
    tenantId,
    userId: "00000000000000000000000b",
    roles: ["owner"],
    tier: "free",
  });

const ctxA = ctxFor(TENANT_A);
const ctxB = ctxFor(TENANT_B);

// Constructing the repository must not touch the database or the environment;
// both are resolved lazily, per call.
const records = createRepository<RecordDoc>("records");

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ instance: { dbName: "graft_it" } });
  // src/env.ts caches on first use — nothing above has called it yet.
  process.env.MONGODB_URI = mongod.getUri("graft_it");
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  process.env.APP_ENV = "qa";

  const seed = (id: ObjectId, tenantId: string, name: string) => ({
    _id: id,
    tenantId: new ObjectId(tenantId),
    entityDefId: ENTITY,
    data: { name },
    deletedAt: null,
    createdAt: new Date("2026-01-15T12:00:00.000Z"),
    updatedAt: new Date("2026-01-15T12:00:00.000Z"),
  });

  const db = await getDb();
  await db
    .collection("records")
    .insertMany([
      seed(oid(0xa1), TENANT_A, "A one"),
      seed(oid(0xa2), TENANT_A, "A two"),
      seed(oid(0xa3), TENANT_A, "A three"),
      seed(oid(0xb1), TENANT_B, "B secret"),
      seed(oid(0xb2), TENANT_B, "B other"),
    ]);
}, 120_000);

afterAll(async () => {
  await (await getMongoClient()).close();
  await mongod?.stop();
});

// AC3 — a read never returns another tenant's document.
describe("tenant scoping on reads", () => {
  it("find returns only the calling tenant's documents", async () => {
    const mine = await records.find(ctxA);
    expect(mine).toHaveLength(3);
    expect(mine.every((r) => r.tenantId.equals(new ObjectId(TENANT_A)))).toBe(true);
    expect(JSON.stringify(mine)).not.toContain("secret");
  });

  it("the other tenant sees a completely different set", async () => {
    const theirs = await records.find(ctxB);
    expect(theirs.map((r) => r.data.name).sort()).toEqual(["B other", "B secret"]);
  });

  it("findById of another tenant's document is a miss, not a leak", async () => {
    expect(await records.findById(ctxB, oid(0xb1))).not.toBeNull();
    expect(await records.findById(ctxA, oid(0xb1))).toBeNull();
  });

  it("count is scoped too", async () => {
    expect(await records.count(ctxA)).toBe(3);
    expect(await records.count(ctxB)).toBe(2);
  });

  it("a caller filter can narrow the scope but never widen it", async () => {
    expect(await records.find(ctxA, { entityDefId: ENTITY })).toHaveLength(3);
    expect(await records.find(ctxA, { "data.name": "B secret" })).toHaveLength(0);
  });
});

// AC2 — a caller-supplied tenantId is rejected, never merged.
describe("tenantId in a caller-supplied filter", () => {
  it("throws instead of overriding the injected value", async () => {
    await expect(
      records.find(ctxA, { tenantId: new ObjectId(TENANT_B) }),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it("throws even when it is hidden inside $or", async () => {
    const filter = { $or: [{ "data.name": "x" }, { tenantId: new ObjectId(TENANT_B) }] };
    await expect(records.find(ctxA, filter)).rejects.toBeInstanceOf(TenantScopeError);
  });

  it("throws when an update tries to move a document to another tenant", async () => {
    const update = { $set: { tenantId: new ObjectId(TENANT_B) } };
    await expect(records.updateOne(ctxA, { _id: oid(0xa1) }, update)).rejects.toBeInstanceOf(
      TenantScopeError,
    );
  });

  it("throws when an inserted document carries its own tenantId", async () => {
    // A hand-written tenantId is already a type error on insertOne; the cast is
    // here to prove the runtime guard also holds for data that arrives untyped.
    const smuggled = {
      tenantId: new ObjectId(TENANT_B),
      entityDefId: ENTITY,
      data: { name: "smuggled" },
      deletedAt: null,
    } as unknown as TenantDoc<RecordDoc>;
    await expect(records.insertOne(ctxA, smuggled)).rejects.toBeInstanceOf(TenantScopeError);
  });
});

describe("tenant scoping on writes", () => {
  it("insertOne stamps the calling tenant and the timestamps", async () => {
    const created = await records.insertOne(ctxB, {
      entityDefId: ENTITY,
      data: { name: "B fresh" },
      deletedAt: null,
    });
    expect(created.tenantId.equals(new ObjectId(TENANT_B))).toBe(true);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(await records.findById(ctxA, created._id)).toBeNull();
    await records.softDelete(ctxB, created._id);
  });

  it("updateOne cannot touch another tenant's document", async () => {
    const update = { $set: { data: { name: "owned" } } };
    expect(await records.updateOne(ctxA, { _id: oid(0xb1) }, update)).toBeNull();
    expect((await records.findById(ctxB, oid(0xb1)))?.data.name).toBe("B secret");
  });

  it("softDelete is scoped and hides the document from later reads", async () => {
    expect(await records.softDelete(ctxA, oid(0xb2))).toBe(false);
    expect(await records.softDelete(ctxA, oid(0xa3))).toBe(true);
    expect(await records.count(ctxA)).toBe(2);
    expect(await records.findById(ctxA, oid(0xa3))).toBeNull();
    expect(await records.count(ctxB)).toBe(2);
  });
});

// AC8 — the cursor helper drives a real paged read, still tenant-scoped.
describe("listPage", () => {
  it("pages within the tenant and round-trips an opaque cursor", async () => {
    const first = await records.listPage(ctxA, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.meta.hasMore).toBe(true);
    expect(decodeCursor(first.meta.cursor!).id).toBe(first.items[0]._id.toHexString());

    const second = await records.listPage(ctxA, { limit: 1, cursor: first.meta.cursor! });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]._id.equals(first.items[0]._id)).toBe(false);
    expect(second.meta.hasMore).toBe(false);
  });

  it("never pages into another tenant", async () => {
    const all = await records.listPage(ctxB, { limit: 50 });
    expect(all.items.every((r) => r.tenantId.equals(new ObjectId(TENANT_B)))).toBe(true);
    expect(all.meta.cursor).toBeNull();
  });
});

// AC1 — omitting ctx is a compile-time error, enforced by `npm run typecheck`:
// if ctx ever became optional, the @ts-expect-error below would itself fail.
describe("ctx is mandatory", () => {
  it("does not type-check without a ctx", () => {
    // @ts-expect-error every repository method requires a ctx (AC1)
    const withoutCtx = () => records.find();
    expect(typeof withoutCtx).toBe("function");
  });
});
