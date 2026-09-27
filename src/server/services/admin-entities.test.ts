/** Cross-tenant entity-definition reads: schema metadata and counts only. */
import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/repositories/base", () => ({
  createRepository: vi.fn(() => {
    throw new Error("createRepository must never be constructed by the admin read surface");
  }),
}));

import {
  buildEntityFilter,
  listAdminEntities,
  toAdminEntity,
  type AdminEntityDoc,
} from "./admin-entities";

const oid = (n: number) => new ObjectId(String(n).padStart(24, "0"));

const entityDoc = (n: number, over: Partial<AdminEntityDoc> = {}): AdminEntityDoc => ({
  _id: oid(n),
  tenantId: oid(900),
  key: `thing_${n}`,
  name: `Thing ${n}`,
  fields: [
    { key: "title", label: "Title", type: "text", required: true, options: ["x"] } as never,
  ],
  schemaVersion: 2,
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-02T00:00:00Z"),
  ...over,
});

describe("toAdminEntity", () => {
  it("emits field metadata only, with the record count and tenant label joined in", () => {
    const entity = toAdminEntity(
      entityDoc(1),
      new Map([[oid(1).toHexString(), 42]]),
      new Map([[oid(900).toHexString(), { name: "Acme", slug: "acme" }]]),
    );
    expect(entity.recordCount).toBe(42);
    expect(entity.tenantName).toBe("Acme");
    expect(entity.fields).toEqual([
      { key: "title", label: "Title", type: "text", required: true },
    ]);
    expect(entity.deleted).toBe(false);
  });

  it("defaults a missing count to zero and marks a soft-deleted definition", () => {
    const entity = toAdminEntity(entityDoc(1, { deletedAt: new Date() }), new Map(), new Map());
    expect(entity.recordCount).toBe(0);
    expect(entity.deleted).toBe(true);
    expect(entity.tenantName).toBeNull();
  });
});

describe("buildEntityFilter", () => {
  it("shows live definitions by default and honours include/only", () => {
    expect(buildEntityFilter({}).deletedAt).toBeNull();
    expect(buildEntityFilter({ deleted: "include" }).deletedAt).toBeUndefined();
    expect(buildEntityFilter({ deleted: "only" }).deletedAt).toEqual({ $ne: null });
  });

  it("scopes to a tenant and escapes q across name and key", () => {
    const filter = buildEntityFilter({ tenantId: oid(7).toHexString(), q: "a+" }) as {
      tenantId: ObjectId;
      $or: { name: { $regex: string } }[];
    };
    expect(filter.tenantId).toEqual(oid(7));
    expect(filter.$or[0]?.name.$regex).toBe("a\\+");
  });
});

describe("listAdminEntities", () => {
  it("asks for counts only for the page's own definitions", async () => {
    let countedFor: ObjectId[] = [];
    const result = await listAdminEntities(
      { limit: "1" },
      {
        store: {
          listEntities: async (_f, limit) => [entityDoc(2), entityDoc(1)].slice(0, limit),
          recordCounts: async (ids) => {
            countedFor = ids;
            return new Map();
          },
          tenantLabels: async () => new Map(),
        },
      },
    );
    expect(result.items).toHaveLength(1);
    expect(result.meta.hasMore).toBe(true);
    expect(countedFor).toEqual([oid(2)]);
  });
});
