/**
 * Metering against a real MongoDB (GRAFT-05 AC3, AC7, and the cross-tenant
 * isolation the Test Contract requires).
 *
 * Atomicity is a claim about the database, so it is asserted where the database
 * is: 50 concurrent increments must leave the counter at exactly 50, which is
 * only true if the guarded `$inc` is a single round trip and not a
 * read-then-write. mongodb-memory-server rather than the QA docker stack, for
 * the same reason as base.integration.test.ts — CI runs `test:integration`
 * before the stack is up, and a proof that only runs locally is not a proof.
 */
import { ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import { getDb, getMongoClient } from "@/server/db/mongo";
import { AppError } from "@/server/http/envelope";
import { TIER_LIMITS } from "@/server/tiers";
import { can, loadEntitlements } from "./entitlements";
import { checkQuota, consumeQuota, mongoMeterStore, peekQuota } from "./meters";

const TENANT_A = "000000000000000000000001";
const TENANT_B = "000000000000000000000002";
const TENANT_DOWN = "000000000000000000000003";
const USER = "00000000000000000000000b";

/** Anchored on the 1st so the period is the calendar month and the assertions
 * below never straddle an anniversary mid-run. */
const ANCHOR_DAY = 1;
const NOW = new Date("2026-03-20T12:00:00.000Z");
const PERIOD = "2026-03";

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
const ctxDown = ctxFor(TENANT_DOWN);

const deps = (emitWarning = vi.fn()) => ({
  store: mongoMeterStore(),
  now: () => NOW,
  emitWarning,
});

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ instance: { dbName: "graft_meters" } });
  process.env.MONGODB_URI = mongod.getUri("graft_meters");
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  process.env.APP_ENV = "qa";

  const db = await getDb();
  // The production index (scripts/create-indexes.ts): one counter per
  // (tenantId, meter, period), enforced by the database rather than by hope.
  await db
    .collection("usage_meters")
    .createIndex({ tenantId: 1, meter: 1, period: 1 }, { unique: true });

  await db.collection("tenants").insertMany([
    {
      _id: new ObjectId(TENANT_A),
      name: "A",
      slug: "a",
      tier: "free",
      limits: { ...TIER_LIMITS.free },
      billingAnchorDay: ANCHOR_DAY,
    },
    {
      _id: new ObjectId(TENANT_B),
      name: "B",
      slug: "b",
      tier: "free",
      limits: { ...TIER_LIMITS.free },
      billingAnchorDay: ANCHOR_DAY,
    },
    {
      // Downgraded to Free while sitting over the Premium record count: the
      // over-limit resources are frozen, and the csv_import grant is gone.
      _id: new ObjectId(TENANT_DOWN),
      name: "Down",
      slug: "down",
      tier: "free",
      limits: { ...TIER_LIMITS.free },
      readOnly: ["records", "entities"],
      downgradedAt: NOW,
      billingAnchorDay: ANCHOR_DAY,
    },
  ]);
}, 120_000);

afterAll(async () => {
  await (await getMongoClient()).close();
  await mongod?.stop();
});

beforeEach(async () => {
  await usageMeters().then((c) => c.deleteMany({}));
});

const usageMeters = async () => (await getDb()).collection("usage_meters");

const meterDoc = async (tenantId: string, meter: string, period: string) =>
  (await usageMeters()).findOne({ tenantId: new ObjectId(tenantId), meter, period });

const counterFor = (tenantId: string, meter = "form_submissions") =>
  meterDoc(tenantId, meter, PERIOD);

// AC3 — the whole point of the guarded $inc.
describe("atomic increment", () => {
  it("50 concurrent increments against a limit of 100 leave the counter at exactly 50", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => checkQuota(ctxA, "form_submissions", 1, deps())),
    );

    expect(results.every((r) => r.allowed)).toBe(true);
    expect((await counterFor(TENANT_A))?.count).toBe(50);
    // Every caller saw a distinct `used` — no two increments collapsed into one.
    expect(new Set(results.map((r) => r.used)).size).toBe(50);
  });

  it("concurrent increments at the ceiling admit exactly the remaining headroom", async () => {
    // 95 of 100 used; 20 callers race for the last 5 places.
    await checkQuota(ctxA, "form_submissions", 95, deps());
    const results = await Promise.all(
      Array.from({ length: 20 }, () => checkQuota(ctxA, "form_submissions", 1, deps())),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.filter((r) => !r.allowed).every((r) => r.reason === "quota_exceeded")).toBe(
      true,
    );
    expect((await counterFor(TENANT_A))?.count).toBe(100);
  });

  it("emits the 80% warning exactly once even under a concurrent burst (AC5)", async () => {
    const emit = vi.fn();
    await Promise.all(
      Array.from({ length: 90 }, () => checkQuota(ctxA, "form_submissions", 1, deps(emit))),
    );
    expect((await counterFor(TENANT_A))?.count).toBe(90);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

// The Test Contract's mandatory cross-tenant check.
describe("tenant isolation", () => {
  it("one tenant's counter is neither readable nor incrementable through another's ctx", async () => {
    await checkQuota(ctxA, "form_submissions", 40, deps());

    // B's view of the same meter is its own, empty counter.
    const view = await peekQuota(ctxB, "form_submissions", deps());
    expect(view.used).toBe(0);

    await checkQuota(ctxB, "form_submissions", 1, deps());
    expect((await counterFor(TENANT_A))?.count).toBe(40);
    expect((await counterFor(TENANT_B))?.count).toBe(1);
  });

  it("exhausting one tenant's quota does not constrain another's", async () => {
    await checkQuota(ctxA, "form_submissions", 100, deps());
    expect((await checkQuota(ctxA, "form_submissions", 1, deps())).allowed).toBe(false);
    expect((await checkQuota(ctxB, "form_submissions", 1, deps())).allowed).toBe(true);
  });
});

// AC7 — read, never write; and nothing is removed.
describe("downgraded tenant", () => {
  it("keeps frozen resources readable and refuses the write", async () => {
    const before = await (await getDb()).collection("usage_meters").insertOne({
      tenantId: new ObjectId(TENANT_DOWN),
      meter: "records",
      period: "all",
      count: 4_000,
    });
    expect(before.acknowledged).toBe(true);

    const view = await peekQuota(ctxDown, "records", deps());
    expect(view.used).toBe(4_000);
    expect(view.reason).toBe("read_only");

    const write = await checkQuota(ctxDown, "records", 1, deps());
    expect(write.allowed).toBe(false);
    expect(write.reason).toBe("read_only");

    await expect(consumeQuota(ctxDown, "records", 1, deps())).rejects.toBeInstanceOf(AppError);

    // Nothing deleted, nothing decremented — the data survives the downgrade.
    expect((await meterDoc(TENANT_DOWN, "records", "all"))?.count).toBe(4_000);
  });

  it("still allows writes to meters the downgrade did not freeze", async () => {
    const result = await checkQuota(ctxDown, "form_submissions", 1, deps());
    expect(result.allowed).toBe(true);
  });

  it("loses the entitlements its old tier carried (AC1, AC2)", async () => {
    expect(await can(ctxDown, "csv_import")).toBe(false);
    const entitlements = await loadEntitlements(ctxDown);
    expect(entitlements.tier).toBe("free");
    expect(entitlements.readOnly).toContain("records");
  });
});
