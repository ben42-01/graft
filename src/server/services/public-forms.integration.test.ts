/**
 * Public form submission against a real MongoDB replica set (GRAFT-09 AC1,
 * AC2, AC7, AC10).
 *
 * `MongoMemoryReplSet`, not `MongoMemoryServer`: this is the one place in the
 * codebase that needs a real multi-document transaction, and a standalone
 * mongod refuses `session.withTransaction` outright (`Transaction numbers are
 * only allowed on a replica set member or mongos`). See
 * docker-compose.dev.yml for why the local/QA stacks now run the same way.
 *
 * AC2's rollback is proven by decorating `PublicFormWriteStore.insertRecord`
 * to throw *after* the guarded meter increment has already committed inside
 * the same session — the transaction is completely real throughout; only the
 * failure is synthetic.
 */
import { ObjectId } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createContext } from "@/server/context";
import { getDb, getMongoClient } from "@/server/db/mongo";
import { createRepository } from "@/server/repositories/base";
import { TIER_LIMITS } from "@/server/tiers";
import type { EntityView } from "./entities";
import type { Entitlements } from "./entitlements";
import {
  mongoPublicFormWriteStore,
  submitPublicForm,
  type PublicFormWriteStore,
} from "./public-forms";
import type { RecordDoc } from "./records";

const TENANT_A = new ObjectId("000000000000000000000001");
const TENANT_B = new ObjectId("000000000000000000000002");
const ENTITY_ID = new ObjectId("000000000000000000000021");
const FORM_A = new ObjectId("000000000000000000000031");
const FORM_B = new ObjectId("000000000000000000000032");

const NOW = new Date("2026-03-20T12:00:00.000Z");
const RENDERED_AT = NOW.getTime() - 5_000;

const field = { key: "name", label: "Name", type: "text" as const, required: true };

const entity = (): EntityView => ({
  id: ENTITY_ID.toHexString(),
  key: "customers",
  name: "Customers",
  fields: [field],
  schemaVersion: 1,
  createdAt: NOW,
  updatedAt: NOW,
});

const entitlementsFor = (over: Partial<Entitlements> = {}): Entitlements =>
  Object.freeze({
    tenantId: TENANT_A.toHexString(),
    tier: "free",
    limits: TIER_LIMITS.free,
    features: {} as Entitlements["features"],
    readOnly: [],
    downgradedAt: null,
    billingAnchorDay: 1,
    ...over,
  });

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, dbName: "graft_public_forms" },
  });
  process.env.MONGODB_URI = replSet.getUri("graft_public_forms");
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  process.env.APP_ENV = "qa";

  const db = await getDb();
  await db
    .collection("usage_meters")
    .createIndex({ tenantId: 1, meter: 1, period: 1 }, { unique: true });
}, 60_000);

afterAll(async () => {
  const client = await getMongoClient();
  await client.close();
  await replSet.stop();
});

beforeEach(async () => {
  const db = await getDb();
  await Promise.all(
    ["records", "form_submissions", "usage_meters", "forms"].map((name) =>
      db.collection(name).deleteMany({}),
    ),
  );
  await db.collection("forms").insertMany([
    {
      _id: FORM_A,
      tenantId: TENANT_A,
      entityDefId: ENTITY_ID,
      name: "Contact",
      slug: "contact",
      publicSlug: "acme/contact",
      visibility: "public",
      published: true,
      enabled: true,
      killSwitchAt: null,
      killSwitchBy: null,
      fields: [field],
      showBadge: true,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      _id: FORM_B,
      tenantId: TENANT_B,
      entityDefId: ENTITY_ID,
      name: "Other Tenant's Form",
      slug: "contact",
      publicSlug: "beta/contact",
      visibility: "public",
      published: true,
      enabled: true,
      killSwitchAt: null,
      killSwitchBy: null,
      fields: [field],
      showBadge: true,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]);
});

const validBody = (name = "Ada Lovelace") => ({
  data: { name },
  _t: RENDERED_AT,
});

const deps = (over: { store?: PublicFormWriteStore; entitlements?: Entitlements } = {}) => ({
  getEntity: async () => entity(),
  loadEntitlements: async () => over.entitlements ?? entitlementsFor(),
  store: over.store ?? mongoPublicFormWriteStore(),
  now: () => NOW,
});

describe("submitPublicForm — real transaction", () => {
  it("AC1 — a valid submission creates exactly one submission, one record, and increments the meter by 1", async () => {
    const result = await submitPublicForm("req-1", ["acme", "contact"], validBody(), deps());
    expect(result.submissionId).toMatch(/^[0-9a-f]{24}$/);

    const db = await getDb();
    const submissions = await db
      .collection("form_submissions")
      .find({ tenantId: TENANT_A })
      .toArray();
    const records = await db.collection("records").find({ tenantId: TENANT_A }).toArray();
    const meter = await db
      .collection("usage_meters")
      .findOne({ tenantId: TENANT_A, meter: "form_submissions" });

    expect(submissions).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(records[0]?.data).toEqual({ name: "Ada Lovelace" });
    expect(submissions[0]?.recordId).toEqual(records[0]?._id);
    expect(meter?.count).toBe(1);
  });

  it("AC2 — an induced failure after the meter increment leaves no submission, no record and no meter increment", async () => {
    const real = mongoPublicFormWriteStore();
    const inducedStore: PublicFormWriteStore = {
      ...real,
      insertRecord: async () => {
        throw new Error("induced failure");
      },
    };

    await expect(
      submitPublicForm(
        "req-1",
        ["acme", "contact"],
        validBody(),
        deps({ store: inducedStore }),
      ),
    ).rejects.toThrow("induced failure");

    const db = await getDb();
    const submissions = await db
      .collection("form_submissions")
      .find({ tenantId: TENANT_A })
      .toArray();
    const records = await db.collection("records").find({ tenantId: TENANT_A }).toArray();
    const meter = await db
      .collection("usage_meters")
      .findOne({ tenantId: TENANT_A, meter: "form_submissions" });

    expect(submissions).toHaveLength(0);
    expect(records).toHaveLength(0);
    // The guarded increment ran and "succeeded" from Mongo's point of view
    // before the induced failure — the transaction aborting is the only
    // reason this is 0 and not 1, which is the entire point of the test.
    expect(meter?.count ?? 0).toBe(0);
  });

  it("AC7 — a tenant at exactly the quota limit is refused with no data written, one point under still succeeds", async () => {
    // Quota state comes from real submissions, not a hand-seeded document:
    // seeding a competing usage_meters row under the same unique key races
    // against the transaction's own create-if-absent step (a genuine
    // duplicate-key conflict against an already-committed row behaves
    // differently from the "lost the race inside my own transaction" case
    // the create-if-absent step is written for).
    const limitOfTwo = entitlementsFor({
      limits: { ...TIER_LIMITS.free, submissionsPerMonth: 2 },
    });
    const db = await getDb();

    // 1 of 2 — succeeds.
    await expect(
      submitPublicForm(
        "req-1",
        ["acme", "contact"],
        validBody("First"),
        deps({ entitlements: limitOfTwo }),
      ),
    ).resolves.toMatchObject({ submissionId: expect.any(String) });

    // 2 of 2 — still at, not over, the limit: still succeeds (the boundary
    // check is `count <= limit - amount`, so this proves it isn't off by one).
    await expect(
      submitPublicForm(
        "req-1",
        ["acme", "contact"],
        validBody("Second"),
        deps({ entitlements: limitOfTwo }),
      ),
    ).resolves.toMatchObject({ submissionId: expect.any(String) });

    let meter = await db
      .collection("usage_meters")
      .findOne({ tenantId: TENANT_A, meter: "form_submissions" });
    expect(meter?.count).toBe(2);

    // 3rd — now over the limit: refused, no data written, counter untouched.
    await expect(
      submitPublicForm(
        "req-1",
        ["acme", "contact"],
        validBody("Third"),
        deps({ entitlements: limitOfTwo }),
      ),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });

    const records = await db.collection("records").find({ tenantId: TENANT_A }).toArray();
    meter = await db
      .collection("usage_meters")
      .findOne({ tenantId: TENANT_A, meter: "form_submissions" });
    expect(records).toHaveLength(2);
    expect(meter?.count).toBe(2);
  });

  it("AC10 — a webhook-style submission for tenant A's slug never reaches tenant B's data", async () => {
    await submitPublicForm("req-1", ["acme", "contact"], validBody(), deps());

    const db = await getDb();
    const tenantBRecords = await db
      .collection("records")
      .find({ tenantId: TENANT_B })
      .toArray();
    const tenantASubmissions = await db
      .collection("form_submissions")
      .find({ tenantId: TENANT_A })
      .toArray();

    expect(tenantBRecords).toHaveLength(0);
    expect(tenantASubmissions).toHaveLength(1);
    expect(tenantASubmissions[0]?.tenantId).toEqual(TENANT_A);
  });

  it("AC10 — the created record is genuinely unreachable through tenant B's own repository-scoped read, even by its real id", async () => {
    // The weak version of this proof just checks tenantId on the stored
    // document, which is true by construction (submitPublicForm writes
    // exactly one tenantId, taken from the form). The real question a public,
    // ctx-less endpoint has to answer is adversarial: can *anything* about
    // the request cause the write to land somewhere a different tenant's own
    // scoped queries can reach? Two attempts:

    // Attempt 1 — smuggle a tenantId through the submitted data. The form's
    // compiled schema is `.strict()` over exactly its own field keys
    // (entities.ts), so an extra key is a 400, not a silently-dropped or
    // silently-honoured field.
    await expect(
      submitPublicForm(
        "req-1",
        ["acme", "contact"],
        { data: { name: "Attacker", tenantId: TENANT_B.toHexString() }, _t: RENDERED_AT },
        deps(),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    // Attempt 2 — a legitimate submission, then ask tenant B's own
    // repository-scoped view for that exact record by its real _id. This is
    // the same proof repositories/base.integration.test.ts uses for the
    // authenticated CRUD paths: tenant isolation is enforced by the
    // repository layer injecting ctx.tenantId into every query, not by the
    // caller happening not to ask.
    const result = await submitPublicForm("req-1", ["acme", "contact"], validBody(), deps());
    const db = await getDb();
    const submission = await db
      .collection("form_submissions")
      .findOne({ _id: new ObjectId(result.submissionId) });
    const recordId = submission?.recordId as ObjectId;
    expect(recordId).toBeTruthy();

    const recordsRepo = createRepository<RecordDoc>("records");
    const ctxB = createContext({
      requestId: "req-attacker",
      tenantId: TENANT_B.toHexString(),
      userId: "000000000000000000000099",
      roles: ["owner"],
      tier: "free",
    });
    await expect(recordsRepo.findById(ctxB, recordId)).resolves.toBeNull();

    // Tenant A's own scoped view, by contrast, finds it — proving the null
    // above is tenant scoping, not a bug that hides the record from everyone.
    const ctxA = createContext({
      requestId: "req-owner",
      tenantId: TENANT_A.toHexString(),
      userId: "000000000000000000000098",
      roles: ["owner"],
      tier: "free",
    });
    await expect(recordsRepo.findById(ctxA, recordId)).resolves.not.toBeNull();
  });
});
