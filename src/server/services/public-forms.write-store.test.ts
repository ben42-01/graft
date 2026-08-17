/**
 * Public form submission — the Mongo adapter and the full success path
 * (GRAFT-09), with `@/server/db/mongo` mocked at the module boundary.
 *
 * public-forms.integration.test.ts proves these same writes are atomic
 * against a real transaction; this file proves the *shape* of each call
 * `mongoPublicFormWriteStore` makes (the guard filter, the upsert, the
 * documents inserted) without needing a database — the same split the rest
 * of the pyramid uses (docs/BACKEND.md §7.1), applied to `submitPublicForm`'s
 * own DB adapter rather than to a shared one like meters.ts's.
 */
import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityView } from "@/server/services/entities";
import type { FormDoc } from "@/server/services/forms";
import type { Entitlements } from "@/server/services/entitlements";
import { TIER_LIMITS } from "@/server/tiers";

const insertOne = vi.fn();
const updateOne = vi.fn();
const findOneAndUpdate = vi.fn();
const findOne = vi.fn();
const collection = vi.fn(() => ({ insertOne, updateOne, findOneAndUpdate, findOne }));
const getDb = vi.fn(async () => ({ collection }));

const withTransaction = vi.fn(async (fn: () => Promise<unknown>) => fn());
const endSession = vi.fn(async () => undefined);
const startSession = vi.fn(() => ({ withTransaction, endSession }));
const getMongoClient = vi.fn(async () => ({ startSession }));

vi.mock("@/server/db/mongo", () => ({ getDb, getMongoClient }));

const { mongoPublicFormWriteStore, submitPublicForm } = await import("./public-forms");

const TENANT = new ObjectId("000000000000000000000001");
const ENTITY_ID = new ObjectId("000000000000000000000021");
const FORM_ID = new ObjectId("000000000000000000000031");
const PERIOD = "2026-03";
const NOW = new Date("2026-03-20T12:00:00.000Z");

const SESSION = {} as never; // opaque to the store — never inspected, only threaded through

beforeEach(() => {
  vi.clearAllMocks();
  insertOne.mockResolvedValue({ insertedId: new ObjectId() });
  updateOne.mockResolvedValue({ matchedCount: 1 });
  findOneAndUpdate.mockResolvedValue({ count: 1 });
  findOne.mockResolvedValue(null);
  withTransaction.mockImplementation(async (fn: () => Promise<unknown>) => fn());
});

describe("resolveDeps' default port", () => {
  it("findByPublicSlug falls back to forms.findByPublicSlug when not overridden", async () => {
    // No `findByPublicSlug` override — resolveDeps's default arrow (the real
    // ctx-less lookup, forms.ts) is what runs, against the mocked db above.
    await expect(
      submitPublicForm("req-1", ["acme", "contact"], { data: {}, _t: 0 }, {}),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(collection).toHaveBeenCalledWith("forms");
    expect(findOne).toHaveBeenCalledWith({ publicSlug: "acme/contact", deletedAt: null });
  });
});

describe("mongoPublicFormWriteStore", () => {
  it("ensureMeterDoc upserts on the unique key with $setOnInsert, never insertOne", async () => {
    const store = mongoPublicFormWriteStore();
    await store.ensureMeterDoc(SESSION, TENANT, PERIOD, NOW);

    expect(collection).toHaveBeenCalledWith("usage_meters");
    expect(insertOne).not.toHaveBeenCalled();
    expect(updateOne).toHaveBeenCalledWith(
      { tenantId: TENANT, meter: "form_submissions", period: PERIOD, deletedAt: null },
      expect.objectContaining({ $setOnInsert: expect.objectContaining({ count: 0 }) }),
      { session: SESSION, upsert: true },
    );
  });

  it("incrementMeter's guard omits the count filter entirely when the limit is null (AC8)", async () => {
    const store = mongoPublicFormWriteStore();
    await store.incrementMeter(SESSION, TENANT, PERIOD, null, NOW);

    const [filter] = findOneAndUpdate.mock.calls[0]!;
    expect(filter).not.toHaveProperty("count");
  });

  it("incrementMeter guards with count <= limit - 1 when the limit is set", async () => {
    const store = mongoPublicFormWriteStore();
    await store.incrementMeter(SESSION, TENANT, PERIOD, 100, NOW);

    const [filter] = findOneAndUpdate.mock.calls[0]!;
    expect(filter).toMatchObject({ count: { $lte: 99 } });
  });

  it("incrementMeter returns false when the guard refuses the update", async () => {
    findOneAndUpdate.mockResolvedValue(null);
    const store = mongoPublicFormWriteStore();
    await expect(store.incrementMeter(SESSION, TENANT, PERIOD, 1, NOW)).resolves.toBe(false);
  });

  it("insertRecord and insertSubmission write to their own collections, session-bound", async () => {
    const store = mongoPublicFormWriteStore();
    const recordId = new ObjectId();
    await store.insertRecord(SESSION, {
      _id: recordId,
      tenantId: TENANT,
      entityDefId: ENTITY_ID,
      schemaVersion: 1,
      data: { name: "Ada" },
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(collection).toHaveBeenCalledWith("records");
    expect(insertOne).toHaveBeenCalledWith(expect.objectContaining({ _id: recordId }), {
      session: SESSION,
    });

    const submissionId = new ObjectId();
    await store.insertSubmission(SESSION, {
      _id: submissionId,
      tenantId: TENANT,
      formId: FORM_ID,
      recordId,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(collection).toHaveBeenCalledWith("form_submissions");
    expect(insertOne).toHaveBeenCalledWith(expect.objectContaining({ recordId }), {
      session: SESSION,
    });
  });
});

describe("submitPublicForm — the real store, session and client wired end to end", () => {
  const field = { key: "name", label: "Name", type: "text" as const, required: true };

  const formDoc = (): FormDoc & { _id: ObjectId } => ({
    _id: FORM_ID,
    tenantId: TENANT,
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
  });

  const entity = (): EntityView => ({
    id: ENTITY_ID.toHexString(),
    key: "customers",
    name: "Customers",
    fields: [field],
    schemaVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });

  const entitlements = (): Entitlements =>
    Object.freeze({
      tenantId: TENANT.toHexString(),
      tier: "free",
      limits: TIER_LIMITS.free,
      features: {} as Entitlements["features"],
      readOnly: [],
      downgradedAt: null,
      billingAnchorDay: 1,
    });

  it("a valid submission drives a real session through getMongoClient and commits via withTransaction", async () => {
    const result = await submitPublicForm(
      "req-1",
      ["acme", "contact"],
      { data: { name: "Ada Lovelace" }, _t: NOW.getTime() - 5_000 },
      {
        findByPublicSlug: async () => formDoc(),
        getEntity: async () => entity(),
        loadEntitlements: async () => entitlements(),
        now: () => NOW,
      },
    );

    expect(result.submissionId).toMatch(/^[0-9a-f]{24}$/);
    expect(startSession).toHaveBeenCalledOnce();
    expect(withTransaction).toHaveBeenCalledOnce();
    expect(endSession).toHaveBeenCalledOnce();
    // The real store, exercised through the whole call: one guarded meter
    // upsert+increment, one record insert, one submission insert.
    expect(collection).toHaveBeenCalledWith("usage_meters");
    expect(collection).toHaveBeenCalledWith("records");
    expect(collection).toHaveBeenCalledWith("form_submissions");
  });

  it("a downgrade freeze on form_submissions refuses before any write is attempted", async () => {
    await expect(
      submitPublicForm(
        "req-1",
        ["acme", "contact"],
        { data: { name: "Ada Lovelace" }, _t: NOW.getTime() - 5_000 },
        {
          findByPublicSlug: async () => formDoc(),
          getEntity: async () => entity(),
          loadEntitlements: async () => ({ ...entitlements(), readOnly: ["form_submissions"] }),
          now: () => NOW,
        },
      ),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });

    expect(insertOne).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("AC7 — a refused guarded increment aborts before the record or submission is written", async () => {
    findOneAndUpdate.mockResolvedValue(null);

    await expect(
      submitPublicForm(
        "req-1",
        ["acme", "contact"],
        { data: { name: "Ada Lovelace" }, _t: NOW.getTime() - 5_000 },
        {
          findByPublicSlug: async () => formDoc(),
          getEntity: async () => entity(),
          loadEntitlements: async () => entitlements(),
          now: () => NOW,
        },
      ),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });

    expect(collection).not.toHaveBeenCalledWith("records");
    expect(collection).not.toHaveBeenCalledWith("form_submissions");
  });

  it("still ends the session even when the transaction throws", async () => {
    withTransaction.mockRejectedValue(new Error("boom"));

    await expect(
      submitPublicForm(
        "req-1",
        ["acme", "contact"],
        { data: { name: "Ada Lovelace" }, _t: NOW.getTime() - 5_000 },
        {
          findByPublicSlug: async () => formDoc(),
          getEntity: async () => entity(),
          loadEntitlements: async () => entitlements(),
          now: () => NOW,
        },
      ),
    ).rejects.toThrow("boom");

    expect(endSession).toHaveBeenCalledOnce();
  });
});
