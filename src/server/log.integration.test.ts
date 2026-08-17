/**
 * GRAFT-17 AC4 — a real E11000, from a real driver, on a unique index over a
 * tenant-named field: the log line must carry the field *name* and the index and
 * none of the value.
 *
 * The point of doing this against a database rather than a hand-built Error is
 * that the shape being relied on (`code`, `index`, `keyPattern`, `keyValue`) is
 * the driver's, not ours — a unit test asserting a fixture would keep passing if
 * the driver renamed a field tomorrow. mongodb-memory-server rather than the QA
 * docker stack, for the same reason as base.integration.test.ts: CI runs
 * `test:integration` before the stack is up, and a proof that only runs on a
 * laptop is not a proof.
 */
import { MongoServerError, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb, getMongoClient } from "@/server/db/mongo";
import { createLogger } from "./log";

const TENANT = "000000000000000000000001";
/** Whatever the tenant called it (GRAFT-06/07) — unknowable to any deny-list. */
const TENANT_FIELD = "revenue_registration_no";
const SECRET_VALUE = "IE1234567X";
const INDEX_NAME = "tenant_revenue_registration_no_idx";

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ instance: { dbName: "graft_log_it" } });
  process.env.MONGODB_URI = mongod.getUri("graft_log_it");
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  process.env.APP_ENV = "qa";

  const db = await getDb();
  await db
    .collection("records")
    .createIndex(
      { tenantId: 1, [`data.${TENANT_FIELD}`]: 1 },
      { unique: true, name: INDEX_NAME },
    );
}, 120_000);

afterAll(async () => {
  await (await getMongoClient()).close();
  await mongod?.stop();
});

afterEach(() => vi.restoreAllMocks());

/** Provokes the collision and hands back what the driver actually threw. */
async function duplicateKeyError(): Promise<unknown> {
  const db = await getDb();
  const doc = {
    tenantId: new ObjectId(TENANT),
    data: { [TENANT_FIELD]: SECRET_VALUE },
  };
  await db.collection("records").insertOne({ ...doc, _id: new ObjectId() });
  try {
    await db.collection("records").insertOne({ ...doc, _id: new ObjectId() });
    throw new Error("expected a duplicate-key error and did not get one");
  } catch (error) {
    return error;
  }
}

describe("a real duplicate-key error on a tenant-named index (AC4)", () => {
  it("logs the field name and the index, and none of the value", async () => {
    const error = await duplicateKeyError();
    // Guard the premise: if this is not the driver's error, the test proves nothing.
    expect(error).toBeInstanceOf(MongoServerError);
    expect((error as MongoServerError).message).toContain(SECRET_VALUE);

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    createLogger({ requestId: "r-1", tenantId: TENANT }).error("record.write.failed", {
      error,
    });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.error.driver).toMatchObject({
      code: 11000,
      index: INDEX_NAME,
      keys: ["tenantId", `data.${TENANT_FIELD}`],
    });
    expect(entry.error.message).toBeUndefined();

    // The value appears in the driver's message and its keyValue; neither reaches
    // the line, in any form.
    expect(lines[0]).not.toContain(SECRET_VALUE);
    expect(lines[0]).not.toContain("dup key");
    expect(lines[0]).toContain(TENANT_FIELD);
  });
});
