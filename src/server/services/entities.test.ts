/**
 * Entity Builder — unit coverage (GRAFT-06 AC1-AC5, AC7).
 *
 * Everything here runs against a fake repository so the logic that matters —
 * schema compilation, cache reuse, the version-bump rule, quota ordering — is
 * exercised as pure logic. Persistence and cross-tenant scoping are proven for
 * real against MongoDB by bruno/entities/*.bru.
 */
import {
  MongoServerError,
  ObjectId,
  type Filter,
  type UpdateFilter,
  type WithId,
} from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import type { Repository } from "@/server/repositories/base";
import {
  compileEntitySchema,
  compileFieldSchema,
  createEntity,
  deleteEntity,
  getCompiledSchema,
  nextSchemaVersion,
  updateEntity,
  type EntityDefDoc,
  type FieldDef,
  type SchemaCache,
} from "./entities";

const TENANT = "000000000000000000000001";
const USER = "00000000000000000000000b";

const ctx: Ctx = createContext({
  requestId: "req-entities",
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

/** A minimal in-memory stand-in for the repository port (base.ts). */
function fakeRepo(seed: (WithId<EntityDefDoc> & { tenantId: ObjectId })[] = []) {
  const docs = new Map(seed.map((d) => [d._id.toHexString(), d]));
  const tenantId = new ObjectId(TENANT);

  const repo: Repository<EntityDefDoc> = {
    collectionName: "entity_defs",
    collection: vi.fn() as unknown as Repository<EntityDefDoc>["collection"],

    async find() {
      return [...docs.values()].filter((d) => d.tenantId.equals(tenantId) && !d.deletedAt);
    },

    async findOne(_ctx, filter) {
      const f = (filter ?? {}) as Record<string, unknown>;
      return (
        [...docs.values()].find(
          (d) =>
            d.tenantId.equals(tenantId) &&
            !d.deletedAt &&
            (f.key === undefined || d.key === f.key) &&
            (f._id === undefined || d._id.equals(f._id as ObjectId)),
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
      const existing = [...docs.values()].find((d) => d.key === doc.key);
      if (existing)
        throw new MongoServerError({ message: "E11000 duplicate key", code: 11000 });
      const full = {
        ...doc,
        tenantId,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as WithId<EntityDefDoc>;
      const withId = { ...full, _id: new ObjectId() };
      docs.set(withId._id.toHexString(), withId);
      return withId;
    },

    async updateOne(_ctx, filter: Filter<EntityDefDoc>, update: UpdateFilter<EntityDefDoc>) {
      const target = [...docs.values()].find(
        (d) => d.tenantId.equals(tenantId) && d._id.equals((filter as { _id: ObjectId })._id),
      );
      if (!target) return null;
      const set = (update.$set ?? {}) as Partial<EntityDefDoc>;
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
  over: Partial<EntityDefDoc> = {},
): WithId<EntityDefDoc> & { tenantId: ObjectId } => ({
  _id: new ObjectId(),
  tenantId: new ObjectId(TENANT),
  key: "customers",
  name: "Customers",
  fields: [field()],
  schemaVersion: 1,
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

describe("compileFieldSchema", () => {
  it("compiles every field type and rejects the wrong shape", () => {
    const cases: [FieldDef, unknown, boolean][] = [
      [field({ type: "text", required: true }), "hi", true],
      [field({ type: "text", required: true }), 5, false],
      [field({ type: "number", key: "age", required: true, min: 0, max: 120 }), 200, false],
      [field({ type: "number", key: "age", required: true, min: 0, max: 120 }), 42, true],
      [field({ type: "date", key: "dob", required: true }), "2026-01-01", true],
      [
        field({ type: "select", key: "plan", required: true, options: ["free", "premium"] }),
        "gold",
        false,
      ],
      [
        field({ type: "select", key: "plan", required: true, options: ["free", "premium"] }),
        "premium",
        true,
      ],
      [field({ type: "checkbox", key: "active", required: true }), true, true],
      [field({ type: "checkbox", key: "active", required: true }), "yes", false],
      [field({ type: "email", key: "email", required: true }), "not-an-email", false],
      [field({ type: "email", key: "email", required: true }), "a@b.com", true],
      [field({ type: "phone", key: "phone", required: true }), "+353 1 000 0001", true],
      [field({ type: "file", key: "upload", required: true }), "", false],
    ];
    for (const [f, value, ok] of cases) {
      const result = compileFieldSchema(f).safeParse(value);
      expect(result.success, `${f.type}: ${JSON.stringify(value)}`).toBe(ok);
    }
  });

  it("makes a non-required field optional", () => {
    const schema = compileFieldSchema(field({ required: false }));
    expect(schema.safeParse(undefined).success).toBe(true);
  });
});

describe("compileEntitySchema (AC2)", () => {
  it("accepts a valid payload and rejects an invalid one with per-field detail", () => {
    const schema = compileEntitySchema([
      field({ key: "name", required: true }),
      field({ key: "email", type: "email", required: true }),
    ]);
    expect(schema.safeParse({ name: "Ada", email: "ada@example.com" }).success).toBe(true);
    const bad = schema.safeParse({ name: "Ada", email: "not-an-email" });
    expect(bad.success).toBe(false);
  });

  it("rejects unknown fields rather than dropping them (AC6, injection defence)", () => {
    const schema = compileEntitySchema([field({ key: "name", required: true })]);
    const result = schema.safeParse({ name: "Ada", $where: "1=1" });
    expect(result.success).toBe(false);
  });
});

describe("getCompiledSchema cache (AC3)", () => {
  it("does not recompile for the same tenant + entity + version", () => {
    const cache: SchemaCache = new Map();
    const compile = vi.fn(compileEntitySchema);
    const fields = [field()];

    getCompiledSchema(TENANT, "entity-1", 1, fields, cache, compile);
    getCompiledSchema(TENANT, "entity-1", 1, fields, cache, compile);

    expect(compile).toHaveBeenCalledTimes(1);
  });

  it("recompiles once the version bumps", () => {
    const cache: SchemaCache = new Map();
    const compile = vi.fn(compileEntitySchema);
    const fields = [field()];

    getCompiledSchema(TENANT, "entity-1", 1, fields, cache, compile);
    getCompiledSchema(TENANT, "entity-1", 2, fields, cache, compile);

    expect(compile).toHaveBeenCalledTimes(2);
  });
});

describe("nextSchemaVersion (AC4)", () => {
  it("bumps when a required field is added", () => {
    const before = [field({ key: "name", required: true })];
    const after = [
      field({ key: "name", required: true }),
      field({ key: "phone", type: "phone" }),
    ];
    expect(nextSchemaVersion(before, after, 1)).toBe(2);
  });

  it("does not bump when only a label changes", () => {
    const before = [field({ key: "name", label: "Name", required: true })];
    const after = [field({ key: "name", label: "Full Name", required: true })];
    expect(nextSchemaVersion(before, after, 1)).toBe(1);
  });
});

describe("createEntity", () => {
  it("returns CONFLICT for a duplicate key without consuming quota", async () => {
    const { repo } = fakeRepo([seedDoc({ key: "customers" })]);
    const consumeQuota = vi.fn();

    await expect(
      createEntity(
        ctx,
        { key: "customers", name: "Customers", fields: [field()] },
        { repo, consumeQuota },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(consumeQuota).not.toHaveBeenCalled();
  });

  it("propagates a quota refusal without inserting (AC5)", async () => {
    const { repo, docs } = fakeRepo();
    const insertSpy = vi.spyOn(repo, "insertOne");
    const consumeQuota = vi.fn().mockRejectedValue(new AppError("QUOTA_EXCEEDED", "nope"));

    await expect(
      createEntity(
        ctx,
        { key: "widgets", name: "Widgets", fields: [field()] },
        { repo, consumeQuota },
      ),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(insertSpy).not.toHaveBeenCalled();
    expect(docs.size).toBe(0);
  });

  it("creates the entity at schemaVersion 1 once quota allows it", async () => {
    const { repo } = fakeRepo();
    const consumeQuota = vi.fn().mockResolvedValue({ allowed: true });

    const created = await createEntity(
      ctx,
      { key: "widgets", name: "Widgets", fields: [field()] },
      { repo, consumeQuota },
    );
    expect(created.schemaVersion).toBe(1);
    expect(consumeQuota).toHaveBeenCalledWith(ctx, "entities");
  });
});

describe("updateEntity (AC4, AC6)", () => {
  it("bumps schemaVersion when fields change structurally", async () => {
    const doc = seedDoc();
    const { repo } = fakeRepo([doc]);
    const updated = await updateEntity(
      ctx,
      doc._id.toHexString(),
      { fields: [field(), field({ key: "phone", type: "phone" })] },
      { repo },
    );
    expect(updated.schemaVersion).toBe(2);
  });

  it("leaves schemaVersion untouched for a name-only update", async () => {
    const doc = seedDoc();
    const { repo } = fakeRepo([doc]);
    const updated = await updateEntity(
      ctx,
      doc._id.toHexString(),
      { name: "Renamed" },
      { repo },
    );
    expect(updated.schemaVersion).toBe(1);
    expect(updated.name).toBe("Renamed");
  });

  it("returns NOT_FOUND for an id outside the tenant (AC6)", async () => {
    const { repo } = fakeRepo([]);
    await expect(
      updateEntity(ctx, new ObjectId().toHexString(), { name: "X" }, { repo }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("deleteEntity (AC7)", () => {
  it("soft-deletes rather than removing the document", async () => {
    const doc = seedDoc();
    const { repo, docs } = fakeRepo([doc]);
    await deleteEntity(ctx, doc._id.toHexString(), { repo });
    expect(docs.get(doc._id.toHexString())?.deletedAt).not.toBeNull();
  });

  it("returns NOT_FOUND for an already-deleted or foreign entity", async () => {
    const { repo } = fakeRepo([]);
    await expect(
      deleteEntity(ctx, new ObjectId().toHexString(), { repo }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
