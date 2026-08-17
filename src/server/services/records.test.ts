/**
 * Records — unit coverage (GRAFT-07 AC1, AC3, AC4, AC5, AC6, AC7, AC8).
 *
 * The filter/sort grammar and lazy migration are pure logic and exercised
 * directly. Persistence, tenant scoping and real keyset pagination over a
 * seeded set are proven against MongoDB by records.integration.test.ts and
 * bruno/records/*.bru.
 */
import { ObjectId, type Filter, type UpdateFilter, type WithId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import type { EntityView, FieldDef } from "@/server/services/entities";
import type { Repository } from "@/server/repositories/base";
import {
  createRecord,
  deleteRecord,
  getRecord,
  listRecords,
  parseFilterGrammar,
  parseSortGrammar,
  updateRecord,
  type RecordDoc,
} from "./records";

const TENANT = "000000000000000000000001";
const USER = "00000000000000000000000b";
const ENTITY_ID = "000000000000000000000021";

const ctx: Ctx = createContext({
  requestId: "req-records",
  tenantId: TENANT,
  userId: USER,
  roles: ["owner"],
  tier: "free",
});

const field = (over: Partial<FieldDef> = {}): FieldDef => ({
  key: "name",
  label: "Name",
  type: "text",
  required: true,
  ...over,
});

const entity = (over: Partial<EntityView> = {}): EntityView => ({
  id: ENTITY_ID,
  key: "customers",
  name: "Customers",
  fields: [field(), field({ key: "email", type: "email", required: true })],
  schemaVersion: 1,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

/** A field reader mirroring the dotted paths records.ts writes into a filter. */
function fieldValue(doc: WithId<RecordDoc>, key: string): unknown {
  if (key === "_id") return doc._id;
  if (key === "entityDefId") return doc.entityDefId;
  if (key === "createdAt" || key === "updatedAt" || key === "deletedAt") return doc[key];
  if (key.startsWith("data.")) return doc.data[key.slice(5)];
  return undefined;
}

function compareValues(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (a instanceof ObjectId && b instanceof ObjectId)
    return a.toString().localeCompare(b.toString());
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

const isOperatorObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !(value instanceof ObjectId) &&
  !(value instanceof Date);

function valueMatches(actual: unknown, expected: unknown): boolean {
  if (isOperatorObject(expected)) {
    if ("$lt" in expected) return compareValues(actual, expected.$lt) < 0;
    if ("$gt" in expected) return compareValues(actual, expected.$gt) > 0;
    if ("$exists" in expected)
      return expected.$exists ? actual !== undefined : actual === undefined;
    return false;
  }
  if (expected instanceof ObjectId)
    return actual instanceof ObjectId && actual.equals(expected);
  if (expected instanceof Date)
    return actual instanceof Date && actual.getTime() === expected.getTime();
  return actual === expected;
}

/** A minimal in-memory stand-in for the repository port (base.ts), including
 * the $or/$and/$lt/$gt shapes the keyset-pagination cursor produces. */
function fakeRepo(seed: (WithId<RecordDoc> & { tenantId: ObjectId })[] = []) {
  const docs = new Map(seed.map((d) => [d._id.toHexString(), d]));
  const tenantId = new ObjectId(TENANT);

  const matches = (doc: WithId<RecordDoc>, filter: Record<string, unknown>): boolean => {
    for (const [key, value] of Object.entries(filter)) {
      if (key === "$or") {
        if (!(value as Record<string, unknown>[]).some((sub) => matches(doc, sub)))
          return false;
      } else if (key === "$and") {
        if (!(value as Record<string, unknown>[]).every((sub) => matches(doc, sub)))
          return false;
      } else if (!valueMatches(fieldValue(doc, key), value)) {
        return false;
      }
    }
    return true;
  };

  const repo: Repository<RecordDoc> = {
    collectionName: "records",
    collection: vi.fn() as unknown as Repository<RecordDoc>["collection"],

    async find(_ctx, filter, options) {
      const f = (filter ?? {}) as Record<string, unknown>;
      let rows = [...docs.values()].filter(
        (d) => d.tenantId.equals(tenantId) && !d.deletedAt && matches(d, f),
      );
      const sort = options?.sort as Record<string, 1 | -1> | undefined;
      if (sort) {
        rows = [...rows].sort((a, b) => {
          for (const [key, dir] of Object.entries(sort)) {
            const cmp = compareValues(fieldValue(a, key), fieldValue(b, key)) * dir;
            if (cmp !== 0) return cmp;
          }
          return 0;
        });
      }
      if (typeof options?.limit === "number") rows = rows.slice(0, options.limit);
      return rows;
    },

    async findOne(_ctx, filter) {
      const f = (filter ?? {}) as Record<string, unknown>;
      const includeDeleted = "deletedAt" in f;
      return (
        [...docs.values()].find(
          (d) =>
            d.tenantId.equals(tenantId) && (includeDeleted || !d.deletedAt) && matches(d, f),
        ) ?? null
      );
    },

    async findById(_ctx, id) {
      const found = docs.get(id.toString());
      return found && found.tenantId.equals(tenantId) && !found.deletedAt ? found : null;
    },

    async count() {
      return docs.size;
    },

    async insertOne(_ctx, doc) {
      const full = {
        ...doc,
        tenantId,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as WithId<RecordDoc>;
      const withId = { ...full, _id: new ObjectId() };
      docs.set(withId._id.toHexString(), withId);
      return withId;
    },

    async updateOne(_ctx, filter: Filter<RecordDoc>, update: UpdateFilter<RecordDoc>) {
      const target = [...docs.values()].find(
        (d) => d.tenantId.equals(tenantId) && matches(d, filter as Record<string, unknown>),
      );
      if (!target) return null;
      const set = (update.$set ?? {}) as Partial<RecordDoc>;
      const updated = { ...target, ...set, updatedAt: new Date() };
      docs.set(updated._id.toHexString(), updated);
      return updated;
    },

    async softDelete(_ctx, id) {
      const found = docs.get(id.toString());
      if (!found || !found.tenantId.equals(tenantId)) return false;
      docs.set(id.toString(), { ...found, deletedAt: new Date() });
      return true;
    },

    async listPage() {
      const items = [...docs.values()].filter(
        (d) => d.tenantId.equals(tenantId) && !d.deletedAt,
      );
      return { items, meta: { limit: 25, hasMore: false, cursor: null } };
    },
  };
  return { repo, docs };
}

const seedDoc = (
  over: Partial<RecordDoc> = {},
): WithId<RecordDoc> & { tenantId: ObjectId } => ({
  _id: new ObjectId(),
  tenantId: new ObjectId(TENANT),
  entityDefId: new ObjectId(ENTITY_ID),
  schemaVersion: 1,
  data: { name: "Ada", email: "ada@example.com" },
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

describe("parseFilterGrammar (AC3)", () => {
  const fields = entity().fields;

  it("accepts a filter naming real fields", () => {
    const clause = parseFilterGrammar('{"name":"Ada"}', fields);
    expect(clause).toEqual({ "data.name": "Ada" });
  });

  it("rejects a field the entity does not have", () => {
    expect(() => parseFilterGrammar('{"nope":"x"}', fields)).toThrow(AppError);
  });

  it("rejects a raw Mongo operator key ($where, $ne, $gt) — never a whitelisted field", () => {
    for (const hostile of ['{"$where":"1==1"}', '{"$ne":null}', '{"$gt":1}']) {
      expect(() => parseFilterGrammar(hostile, fields)).toThrow(AppError);
    }
  });

  it("rejects an operator smuggled as a field's value", () => {
    expect(() => parseFilterGrammar('{"name":{"$gt":""}}', fields)).toThrow(AppError);
  });

  it("rejects malformed JSON and non-object JSON", () => {
    expect(() => parseFilterGrammar("not json", fields)).toThrow(AppError);
    expect(() => parseFilterGrammar("[1,2,3]", fields)).toThrow(AppError);
    expect(() => parseFilterGrammar('"just a string"', fields)).toThrow(AppError);
  });

  it("returns an empty clause when no filter is given", () => {
    expect(parseFilterGrammar(undefined, fields)).toEqual({});
  });
});

describe("parseSortGrammar (AC4)", () => {
  const fields = entity().fields;

  it("defaults to createdAt descending", () => {
    expect(parseSortGrammar(undefined, fields)).toEqual({
      field: "createdAt",
      mongoField: "createdAt",
      dir: -1,
      isDate: true,
    });
  });

  it("accepts a whitelisted entity field, ascending or descending", () => {
    expect(parseSortGrammar("name", fields)).toMatchObject({ mongoField: "data.name", dir: 1 });
    expect(parseSortGrammar("-name", fields)).toMatchObject({
      mongoField: "data.name",
      dir: -1,
    });
  });

  it("accepts updatedAt as well as createdAt", () => {
    expect(parseSortGrammar("-updatedAt", fields)).toMatchObject({
      mongoField: "updatedAt",
      dir: -1,
    });
  });

  it("rejects a field the entity does not have", () => {
    expect(() => parseSortGrammar("nope", fields)).toThrow(AppError);
  });
});

describe("createRecord (AC1, AC7)", () => {
  it("rejects an unknown field rather than storing it", async () => {
    const { repo } = fakeRepo();
    const getEntity = vi.fn().mockResolvedValue(entity());
    await expect(
      createRecord(
        ctx,
        ENTITY_ID,
        { name: "Ada", email: "ada@example.com", extra: "nope" },
        { repo, getEntity },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("stores a valid record at the entity's current schemaVersion", async () => {
    const { repo } = fakeRepo();
    const getEntity = vi.fn().mockResolvedValue(entity({ schemaVersion: 3 }));
    const consumeQuota = vi.fn().mockResolvedValue({ allowed: true });
    const created = await createRecord(
      ctx,
      ENTITY_ID,
      { name: "Ada", email: "ada@example.com" },
      { repo, getEntity, consumeQuota },
    );
    expect(created.schemaVersion).toBe(3);
    expect(created.data).toEqual({ name: "Ada", email: "ada@example.com" });
  });

  it("propagates a quota refusal without inserting", async () => {
    const { repo, docs } = fakeRepo();
    const getEntity = vi.fn().mockResolvedValue(entity());
    const consumeQuota = vi.fn().mockRejectedValue(new AppError("QUOTA_EXCEEDED", "nope"));
    await expect(
      createRecord(
        ctx,
        ENTITY_ID,
        { name: "Ada", email: "ada@example.com" },
        { repo, getEntity, consumeQuota },
      ),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(docs.size).toBe(0);
  });

  it("404s when the entity is not this tenant's (AC8)", async () => {
    const { repo } = fakeRepo();
    const getEntity = vi.fn().mockRejectedValue(new AppError("NOT_FOUND", "Entity not found"));
    await expect(
      createRecord(ctx, ENTITY_ID, { name: "Ada" }, { repo, getEntity }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("getRecord (AC5, AC6, AC8)", () => {
  it("404s for a record outside the tenant or entity", async () => {
    const { repo } = fakeRepo([]);
    const getEntity = vi.fn().mockResolvedValue(entity());
    await expect(
      getRecord(ctx, ENTITY_ID, new ObjectId().toHexString(), {}, { repo, getEntity }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("404s a soft-deleted record by default but returns it with includeDeleted (AC5)", async () => {
    const doc = seedDoc({ deletedAt: new Date("2026-02-01T00:00:00.000Z") });
    const { repo } = fakeRepo([doc]);
    const getEntity = vi.fn().mockResolvedValue(entity());
    await expect(
      getRecord(ctx, ENTITY_ID, doc._id.toHexString(), {}, { repo, getEntity }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const found = await getRecord(
      ctx,
      ENTITY_ID,
      doc._id.toHexString(),
      { includeDeleted: true },
      { repo, getEntity },
    );
    expect(found.id).toBe(doc._id.toHexString());
  });

  it("migrates a stale record lazily, dropping a field the entity no longer has", async () => {
    const doc = seedDoc({
      schemaVersion: 1,
      data: { name: "Ada", email: "ada@example.com", legacy: "drop me" },
    });
    const { repo, docs } = fakeRepo([doc]);
    // Current entity no longer has "legacy" and has moved to schemaVersion 2.
    const getEntity = vi.fn().mockResolvedValue(entity({ schemaVersion: 2 }));

    const found = await getRecord(
      ctx,
      ENTITY_ID,
      doc._id.toHexString(),
      {},
      { repo, getEntity },
    );

    expect(found.schemaVersion).toBe(2);
    expect(found.data).toEqual({ name: "Ada", email: "ada@example.com" });
    // Persisted, not just returned — the next read does not pay to migrate again.
    expect(docs.get(doc._id.toHexString())?.schemaVersion).toBe(2);
  });
});

describe("updateRecord", () => {
  it("rejects an unknown field", async () => {
    const doc = seedDoc();
    const { repo } = fakeRepo([doc]);
    const getEntity = vi.fn().mockResolvedValue(entity());
    await expect(
      updateRecord(ctx, ENTITY_ID, doc._id.toHexString(), { extra: "x" }, { repo, getEntity }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("merges a partial patch onto the existing data", async () => {
    const doc = seedDoc();
    const { repo } = fakeRepo([doc]);
    const getEntity = vi.fn().mockResolvedValue(entity());
    const updated = await updateRecord(
      ctx,
      ENTITY_ID,
      doc._id.toHexString(),
      { name: "Ada Lovelace" },
      { repo, getEntity },
    );
    expect(updated.data).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
  });

  it("404s for a record outside the tenant or entity (AC8)", async () => {
    const { repo } = fakeRepo([]);
    const getEntity = vi.fn().mockResolvedValue(entity());
    await expect(
      updateRecord(
        ctx,
        ENTITY_ID,
        new ObjectId().toHexString(),
        { name: "x" },
        { repo, getEntity },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("deleteRecord (AC5)", () => {
  it("soft-deletes rather than removing the document", async () => {
    const doc = seedDoc();
    const { repo, docs } = fakeRepo([doc]);
    const getEntity = vi.fn().mockResolvedValue(entity());
    await deleteRecord(ctx, ENTITY_ID, doc._id.toHexString(), { repo, getEntity });
    expect(docs.get(doc._id.toHexString())?.deletedAt).not.toBeNull();
  });

  it("404s for an already-deleted or foreign record", async () => {
    const { repo } = fakeRepo([]);
    const getEntity = vi.fn().mockResolvedValue(entity());
    await expect(
      deleteRecord(ctx, ENTITY_ID, new ObjectId().toHexString(), { repo, getEntity }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("listRecords (AC2, AC3, AC8)", () => {
  it("lists only the given entity's records within the tenant", async () => {
    const docs = [
      seedDoc({ data: { name: "Ada", email: "ada@example.com" } }),
      seedDoc({ data: { name: "Grace", email: "grace@example.com" } }),
      seedDoc({ entityDefId: new ObjectId(), data: { name: "Other entity" } }),
    ];
    const { repo } = fakeRepo(docs);
    const getEntity = vi.fn().mockResolvedValue(entity());
    const { items } = await listRecords(ctx, ENTITY_ID, {}, { repo, getEntity });
    expect(items).toHaveLength(2);
  });

  it("applies the filter grammar to the query", async () => {
    const docs = [
      seedDoc({ data: { name: "Ada", email: "ada@example.com" } }),
      seedDoc({ data: { name: "Grace", email: "grace@example.com" } }),
    ];
    const { repo } = fakeRepo(docs);
    const getEntity = vi.fn().mockResolvedValue(entity());
    const { items } = await listRecords(
      ctx,
      ENTITY_ID,
      { filter: '{"name":"Grace"}' },
      { repo, getEntity },
    );
    expect(items).toHaveLength(1);
    expect(items[0].data.name).toBe("Grace");
  });

  it("rejects a hostile filter before touching the repository", async () => {
    const { repo } = fakeRepo();
    const findSpy = vi.spyOn(repo, "find");
    const getEntity = vi.fn().mockResolvedValue(entity());
    await expect(
      listRecords(ctx, ENTITY_ID, { filter: '{"$where":"1==1"}' }, { repo, getEntity }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(findSpy).not.toHaveBeenCalled();
  });

  it("paginates on the default sort (createdAt desc) with no duplicate or skipped rows", async () => {
    const docs = [
      seedDoc({ createdAt: new Date("2026-01-01T00:00:00.000Z"), data: { name: "One" } }),
      seedDoc({ createdAt: new Date("2026-01-02T00:00:00.000Z"), data: { name: "Two" } }),
      seedDoc({ createdAt: new Date("2026-01-03T00:00:00.000Z"), data: { name: "Three" } }),
    ];
    const { repo } = fakeRepo(docs);
    const getEntity = vi.fn().mockResolvedValue(entity());

    const first = await listRecords(ctx, ENTITY_ID, { limit: 2 }, { repo, getEntity });
    expect(first.items.map((r) => r.data.name)).toEqual(["Three", "Two"]);
    expect(first.meta.hasMore).toBe(true);

    const second = await listRecords(
      ctx,
      ENTITY_ID,
      { limit: 2, cursor: first.meta.cursor! },
      { repo, getEntity },
    );
    expect(second.items.map((r) => r.data.name)).toEqual(["One"]);
    expect(second.meta.hasMore).toBe(false);
  });

  it("paginates on a whitelisted data field, ascending (AC4)", async () => {
    const docs = [
      seedDoc({ data: { name: "Charlie", email: "c@example.com" } }),
      seedDoc({ data: { name: "Alice", email: "a@example.com" } }),
      seedDoc({ data: { name: "Bob", email: "b@example.com" } }),
    ];
    const { repo } = fakeRepo(docs);
    const getEntity = vi.fn().mockResolvedValue(entity());

    const first = await listRecords(
      ctx,
      ENTITY_ID,
      { sort: "name", limit: 2 },
      { repo, getEntity },
    );
    expect(first.items.map((r) => r.data.name)).toEqual(["Alice", "Bob"]);
    expect(first.meta.hasMore).toBe(true);

    const second = await listRecords(
      ctx,
      ENTITY_ID,
      { sort: "name", limit: 2, cursor: first.meta.cursor! },
      { repo, getEntity },
    );
    expect(second.items.map((r) => r.data.name)).toEqual(["Charlie"]);
    expect(second.meta.hasMore).toBe(false);
  });
});
