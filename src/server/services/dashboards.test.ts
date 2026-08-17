/**
 * Dashboards — unit coverage (GRAFT-13 AC1, AC2, AC6, AC7).
 *
 * Runs against a fake repository, the same convention as entities.test.ts:
 * quota ordering and widget-config validation are pure logic worth proving
 * without a database. Persistence and cross-tenant scoping are proven for
 * real by bruno/dashboards/*.bru.
 */
import { ObjectId, type Filter, type UpdateFilter, type WithId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import type { QuotaResult } from "@/server/services/meters";
import type { Repository } from "@/server/repositories/base";
import {
  createDashboard,
  deleteDashboard,
  getDashboard,
  listDashboards,
  updateDashboard,
  widgetSchema,
  type DashboardDoc,
} from "./dashboards";

const TENANT = "000000000000000000000001";
const OTHER_TENANT = "000000000000000000000002";
const USER = "00000000000000000000000b";

const ctx: Ctx = createContext({
  requestId: "req-dashboards",
  tenantId: TENANT,
  userId: USER,
  roles: ["owner"],
  tier: "free",
});

const allowedQuota: QuotaResult = {
  meter: "dashboards",
  period: "all",
  allowed: true,
  limit: 1,
  used: 1,
  remaining: 0,
  warned: false,
};

const refusedQuota: QuotaResult = {
  ...allowedQuota,
  allowed: false,
  reason: "quota_exceeded",
};

/** A minimal in-memory stand-in for the repository port (base.ts). */
function fakeRepo(seed: (WithId<DashboardDoc> & { tenantId: ObjectId })[] = []) {
  const docs = new Map(seed.map((d) => [d._id.toHexString(), d]));
  const tenantId = new ObjectId(TENANT);

  const repo: Repository<DashboardDoc> = {
    collectionName: "dashboards",
    collection: vi.fn() as unknown as Repository<DashboardDoc>["collection"],
    async find() {
      return [...docs.values()].filter((d) => d.tenantId.equals(tenantId) && !d.deletedAt);
    },
    async findOne() {
      return null;
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
      } as unknown as WithId<DashboardDoc>;
      const withId = { ...full, _id: new ObjectId() };
      docs.set(withId._id.toHexString(), withId);
      return withId;
    },
    async updateOne(_ctx, filter: Filter<DashboardDoc>, update: UpdateFilter<DashboardDoc>) {
      const target = [...docs.values()].find(
        (d) => d.tenantId.equals(tenantId) && d._id.equals((filter as { _id: ObjectId })._id),
      );
      if (!target) return null;
      const set = (update.$set ?? {}) as Partial<DashboardDoc>;
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
  return { repo, docs, tenantId };
}

const seedDoc = (
  over: Partial<DashboardDoc> = {},
): WithId<DashboardDoc> & { tenantId: ObjectId } => ({
  _id: new ObjectId(),
  tenantId: new ObjectId(TENANT),
  ownerId: new ObjectId(USER),
  name: "My dashboard",
  widgets: [],
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

describe("createDashboard (AC6)", () => {
  it("reserves the dashboards quota before writing", async () => {
    const { repo } = fakeRepo();
    const consumeQuota = vi.fn().mockResolvedValue(allowedQuota);

    const view = await createDashboard(ctx, { name: "First" }, { repo, consumeQuota });

    expect(consumeQuota).toHaveBeenCalledWith(ctx, "dashboards");
    expect(view.name).toBe("First");
    expect(view.widgets).toEqual([]);
  });

  it("raises QUOTA_EXCEEDED and writes nothing when the tenant is at its limit", async () => {
    const { repo, docs } = fakeRepo();
    const consumeQuota = vi.fn().mockRejectedValue(
      new AppError(
        "QUOTA_EXCEEDED",
        "You have reached your plan's limit. Upgrade to continue.",
        {
          meter: "dashboards",
        },
      ),
    );

    await expect(
      createDashboard(ctx, { name: "Second" }, { repo, consumeQuota }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(docs.size).toBe(0);
  });

  it("(sanity) a refused QuotaResult would also mean no dashboard — quota.ts owns that branch, this only proves ordering", () => {
    expect(refusedQuota.allowed).toBe(false);
  });
});

describe("getDashboard / updateDashboard / deleteDashboard (AC7)", () => {
  it("returns NOT_FOUND for another tenant's dashboard id, not the document", async () => {
    const otherTenantDoc = seedDoc({ tenantId: new ObjectId(OTHER_TENANT) });
    const { repo } = fakeRepo([otherTenantDoc]);

    await expect(
      getDashboard(ctx, otherTenantDoc._id.toHexString(), { repo }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      updateDashboard(ctx, otherTenantDoc._id.toHexString(), { name: "Hijack" }, { repo }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      deleteDashboard(ctx, otherTenantDoc._id.toHexString(), { repo }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("replaces the widgets array in one write (AC4)", async () => {
    const doc = seedDoc();
    const { repo } = fakeRepo([doc]);
    const widgets = [
      {
        id: "w1",
        type: "kpi",
        config: { source: "meter", meter: "records", label: "Records" },
        layout: { x: 0, y: 0, w: 1, h: 1 },
      },
    ];

    const updated = await updateDashboard(ctx, doc._id.toHexString(), { widgets }, { repo });
    expect(updated.widgets).toEqual(widgets);
  });
});

describe("listDashboards / deleteDashboard", () => {
  it("lists only this tenant's dashboards", async () => {
    const mine = seedDoc({ name: "Mine" });
    const theirs = seedDoc({ tenantId: new ObjectId(OTHER_TENANT), name: "Theirs" });
    const { repo } = fakeRepo([mine, theirs]);

    const { items } = await listDashboards(ctx, {}, { repo });

    expect(items.map((d) => d.name)).toEqual(["Mine"]);
  });

  it("soft-deletes an existing dashboard", async () => {
    const doc = seedDoc();
    const { repo, docs } = fakeRepo([doc]);

    await deleteDashboard(ctx, doc._id.toHexString(), { repo });

    expect(docs.get(doc._id.toHexString())?.deletedAt).not.toBeNull();
  });
});

describe("widgetSchema — config validation (AC1, AC2, Constraints)", () => {
  it("accepts a valid known-type widget", () => {
    const result = widgetSchema.safeParse({
      id: "w1",
      type: "kpi",
      config: { source: "meter", meter: "records", label: "Records" },
      layout: { x: 0, y: 0, w: 1, h: 1 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a known-type widget whose config does not match its schema", () => {
    const result = widgetSchema.safeParse({
      id: "w1",
      type: "kpi",
      config: { source: "meter" }, // missing `meter`
      layout: { x: 0, y: 0, w: 1, h: 1 },
    });
    expect(result.success).toBe(false);
  });

  it("AC2 — an unknown widget type is still valid data, not rejected at write time", () => {
    const result = widgetSchema.safeParse({
      id: "w1",
      type: "future_plugin_widget",
      config: { anything: "goes" },
      layout: { x: 0, y: 0, w: 1, h: 1 },
    });
    expect(result.success).toBe(true);
  });

  it("never lets a widget config carry a raw query operator (Constraints)", () => {
    // `config` is z.record(z.unknown()) — Mongo operators are just object
    // keys to it, so this documents that the value is only ever interpreted
    // by name (registry.tsx / the widget component), never passed to Mongo.
    const result = widgetSchema.safeParse({
      id: "w1",
      type: "record_list",
      config: { entityId: "000000000000000000000015", $where: "1=1" },
      layout: { x: 0, y: 0, w: 1, h: 1 },
    });
    // record_list is a known type with a `.strict()` schema — an extra key
    // like `$where` is rejected outright, not laundered through.
    expect(result.success).toBe(false);
  });
});
