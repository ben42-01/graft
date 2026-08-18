/**
 * Plugin registry — unit coverage (GRAFT-14 AC1, AC2, AC3, AC4, AC6, AC7).
 *
 * Runs against fake ports so provisioning ordering, tier gating and quota
 * enforcement are exercised as pure logic, against the *real* first-party
 * catalog (src/server/plugins.ts) — there is no room in the MVP catalog for a
 * "4th free plugin", so AC3 is proven by mocking the quota refusal the same
 * way dashboards.test.ts does, not by inventing a fake manifest. Persistence
 * and cross-tenant scoping are proven for real by bruno/plugins/*.bru.
 */
import { ObjectId, type Filter, type UpdateFilter, type WithId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import type { EntityView } from "@/server/services/entities";
import type { QuotaResult } from "@/server/services/meters";
import type { Entitlements } from "@/server/services/entitlements";
import type { Repository } from "@/server/repositories/base";
import { PLUGIN_REGISTRY, pluginManifestSchema, tierEligible } from "@/server/plugins";
import { disablePlugin, enablePlugin, listPlugins, type PluginEnabledDoc } from "./plugins";

const TENANT = "000000000000000000000001";
const USER = "00000000000000000000000b";

const ctxFor = (tier: "free" | "premium" | "enterprise"): Ctx =>
  createContext({
    requestId: `req-plugins-${tier}`,
    tenantId: TENANT,
    userId: USER,
    roles: ["owner"],
    tier,
  });

const entitlementsFor = (tier: "free" | "premium" | "enterprise"): Entitlements =>
  ({
    tenantId: TENANT,
    tier,
    limits: {} as Entitlements["limits"],
    features: {} as Entitlements["features"],
    readOnly: [],
    downgradedAt: null,
    billingAnchorDay: 1,
  }) as Entitlements;

const allowedQuota: QuotaResult = {
  meter: "plugins",
  period: "all",
  allowed: true,
  limit: 3,
  used: 1,
  remaining: 2,
  warned: false,
};

/** A minimal in-memory stand-in for the repository port (base.ts). */
function fakeRepo(seed: (WithId<PluginEnabledDoc> & { tenantId: ObjectId })[] = []) {
  const docs = new Map(seed.map((d) => [d._id.toHexString(), d]));
  const tenantId = new ObjectId(TENANT);

  const repo: Repository<PluginEnabledDoc> = {
    collectionName: "plugins_enabled",
    collection: vi.fn() as unknown as Repository<PluginEnabledDoc>["collection"],
    async find() {
      return [...docs.values()].filter((d) => d.tenantId.equals(tenantId));
    },
    async findOne(_ctx, filter) {
      const wanted = (filter as { pluginId?: string } | undefined)?.pluginId;
      return (
        [...docs.values()].find(
          (d) => d.tenantId.equals(tenantId) && (!wanted || d.pluginId === wanted),
        ) ?? null
      );
    },
    async findById(_ctx, id) {
      return docs.get(id.toString()) ?? null;
    },
    async count() {
      return docs.size;
    },
    async insertOne(_ctx, doc) {
      const full = { ...doc, tenantId } as unknown as WithId<PluginEnabledDoc>;
      const withId = { ...full, _id: new ObjectId() };
      docs.set(withId._id.toHexString(), withId);
      return withId;
    },
    async updateOne(
      _ctx,
      filter: Filter<PluginEnabledDoc>,
      update: UpdateFilter<PluginEnabledDoc>,
    ) {
      const target = [...docs.values()].find(
        (d) => d.tenantId.equals(tenantId) && d._id.equals((filter as { _id: ObjectId })._id),
      );
      if (!target) return null;
      const set = (update.$set ?? {}) as Partial<PluginEnabledDoc>;
      const updated = { ...target, ...set };
      docs.set(updated._id.toHexString(), updated);
      return updated;
    },
    async softDelete() {
      return false;
    },
    async listPage() {
      const items = [...docs.values()].filter((d) => d.tenantId.equals(tenantId));
      return { items, meta: { limit: 25, hasMore: false, cursor: null } };
    },
  };
  return { repo, docs, tenantId };
}

const seedDoc = (
  over: Partial<PluginEnabledDoc> = {},
): WithId<PluginEnabledDoc> & { tenantId: ObjectId } => ({
  _id: new ObjectId(),
  tenantId: new ObjectId(TENANT),
  pluginId: "contacts",
  enabled: true,
  config: {},
  ...over,
});

const entityView = (over: Partial<EntityView> = {}): EntityView => ({
  id: "000000000000000000000021",
  key: "contacts",
  name: "Contacts",
  fields: [{ key: "name", label: "Name", type: "text", required: true }],
  schemaVersion: 1,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

describe("PLUGIN_REGISTRY — manifest validation (Test Contract: unit)", () => {
  it("every registered manifest is valid data", () => {
    for (const manifest of PLUGIN_REGISTRY) {
      expect(() => pluginManifestSchema.parse(manifest)).not.toThrow();
    }
  });

  it("rejects a manifest whose form binds to an entity it does not declare", () => {
    const malformed = {
      id: "broken",
      name: "Broken",
      version: "1.0.0",
      entities: [],
      forms: [
        {
          key: "f",
          name: "F",
          slug: "f",
          visibility: "internal",
          entityKey: "nonexistent",
          fields: ["name"],
        },
      ],
      widgets: [],
      routes: [],
      permissions: [],
      tier: "free",
    };
    expect(pluginManifestSchema.safeParse(malformed).success).toBe(false);
  });

  it("Context — the three MVP plugins are all Free-tier (fit inside the Free limit of 3)", () => {
    const mvp = PLUGIN_REGISTRY.filter((p) =>
      ["contacts", "forms", "scheduling"].includes(p.id),
    );
    expect(mvp).toHaveLength(3);
    expect(mvp.every((p) => p.tier === "free")).toBe(true);
  });
});

describe("tierEligible (AC4)", () => {
  it("a tenant may enable a plugin at or below its own tier", () => {
    expect(tierEligible("free", "free")).toBe(true);
    expect(tierEligible("premium", "free")).toBe(true);
    expect(tierEligible("free", "premium")).toBe(false);
    expect(tierEligible("premium", "enterprise")).toBe(false);
    expect(tierEligible("enterprise", "enterprise")).toBe(true);
  });
});

describe("listPlugins (AC1, AC4)", () => {
  it("marks a legacy fixture row (no `enabled` field) as enabled", async () => {
    const { repo } = fakeRepo([seedDoc({ pluginId: "contacts", enabled: undefined })]);
    const items = await listPlugins(ctxFor("free"), {
      repo,
      entitlements: async () => entitlementsFor("free"),
    });
    const contacts = items.find((p) => p.id === "contacts");
    expect(contacts?.enabled).toBe(true);
  });

  it("Free tenant is eligible for the free plugins but not premium/enterprise ones", async () => {
    const { repo } = fakeRepo();
    const items = await listPlugins(ctxFor("free"), {
      repo,
      entitlements: async () => entitlementsFor("free"),
    });
    expect(items.find((p) => p.id === "contacts")?.eligible).toBe(true);
    expect(items.find((p) => p.id === "invoicing")?.eligible).toBe(false);
    expect(items.find((p) => p.id === "api-access")?.eligible).toBe(false);
  });
});

describe("enablePlugin (AC1, AC7 — provisioning)", () => {
  it("provisions the manifest's entities and forms through the normal APIs", async () => {
    const { repo, docs } = fakeRepo();
    const createEntity = vi.fn().mockResolvedValue(entityView());
    const createForm = vi.fn().mockResolvedValue({});
    const consumeQuota = vi.fn().mockResolvedValue(allowedQuota);

    const view = await enablePlugin(ctxFor("free"), "contacts", {
      repo,
      entitlements: async () => entitlementsFor("free"),
      consumeQuota,
      createEntity,
      createForm,
    });

    expect(view.enabled).toBe(true);
    expect(createEntity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ key: "contacts" }),
    );
    expect(createForm).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entityId: entityView().id, slug: "contacts-form" }),
    );
    expect([...docs.values()]).toHaveLength(1);
    expect([...docs.values()][0]?.enabled).toBe(true);
  });

  it("treats a CONFLICT from createEntity/createForm as already-provisioned, not an error (AC2 re-enable)", async () => {
    const { repo } = fakeRepo([seedDoc({ pluginId: "contacts", enabled: false })]);
    const createEntity = vi.fn().mockRejectedValue(new AppError("CONFLICT", "exists"));
    const getEntityByKey = vi.fn().mockResolvedValue(entityView());
    const createForm = vi.fn().mockRejectedValue(new AppError("CONFLICT", "exists"));
    const consumeQuota = vi.fn().mockResolvedValue(allowedQuota);

    const view = await enablePlugin(ctxFor("free"), "contacts", {
      repo,
      entitlements: async () => entitlementsFor("free"),
      consumeQuota,
      createEntity,
      getEntityByKey,
      createForm,
    });

    expect(view.enabled).toBe(true);
    expect(getEntityByKey).toHaveBeenCalledWith(expect.anything(), "contacts");
  });
});

describe("enablePlugin — idempotency (AC1, AC2)", () => {
  it("is a no-op when the plugin is already enabled: no quota spent, nothing provisioned", async () => {
    const { repo } = fakeRepo([seedDoc({ pluginId: "contacts", enabled: true })]);
    const consumeQuota = vi.fn();
    const createEntity = vi.fn();

    const view = await enablePlugin(ctxFor("free"), "contacts", {
      repo,
      entitlements: async () => entitlementsFor("free"),
      consumeQuota,
      createEntity,
    });

    expect(view.enabled).toBe(true);
    expect(consumeQuota).not.toHaveBeenCalled();
    expect(createEntity).not.toHaveBeenCalled();
  });
});

describe("enablePlugin — tier gating (AC4)", () => {
  it("refuses a plugin above the tenant's tier before touching quota or provisioning", async () => {
    const { repo } = fakeRepo();
    const consumeQuota = vi.fn();
    const createEntity = vi.fn();

    await expect(
      enablePlugin(ctxFor("free"), "invoicing", {
        repo,
        entitlements: async () => entitlementsFor("free"),
        consumeQuota,
        createEntity,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(consumeQuota).not.toHaveBeenCalled();
    expect(createEntity).not.toHaveBeenCalled();
  });

  it("404s an unknown plugin id", async () => {
    const { repo } = fakeRepo();
    await expect(
      enablePlugin(ctxFor("free"), "does-not-exist", {
        repo,
        entitlements: async () => entitlementsFor("free"),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("enablePlugin — quota (AC3)", () => {
  it("raises QUOTA_EXCEEDED and provisions nothing when the tenant is at its plugin limit", async () => {
    const { repo, docs } = fakeRepo();
    const createEntity = vi.fn();
    const consumeQuota = vi.fn().mockRejectedValue(
      new AppError("QUOTA_EXCEEDED", "You have reached your plan's limit.", {
        meter: "plugins",
      }),
    );

    await expect(
      enablePlugin(ctxFor("free"), "scheduling", {
        repo,
        entitlements: async () => entitlementsFor("free"),
        consumeQuota,
        createEntity,
      }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });

    expect(createEntity).not.toHaveBeenCalled();
    expect(docs.size).toBe(0);
  });
});

describe("disablePlugin (AC2, AC6)", () => {
  it("flips enabled to false without touching provisioned data", async () => {
    const { repo, docs } = fakeRepo([seedDoc({ pluginId: "contacts", enabled: true })]);

    const view = await disablePlugin(ctxFor("free"), "contacts", {
      repo,
      entitlements: async () => entitlementsFor("free"),
    });

    expect(view.enabled).toBe(false);
    expect([...docs.values()][0]?.enabled).toBe(false);
  });

  it("is idempotent when the plugin was never enabled", async () => {
    const { repo } = fakeRepo();
    const view = await disablePlugin(ctxFor("free"), "contacts", {
      repo,
      entitlements: async () => entitlementsFor("free"),
    });
    expect(view.enabled).toBe(false);
  });

  it("404s an unknown plugin id", async () => {
    const { repo } = fakeRepo();
    await expect(
      disablePlugin(ctxFor("free"), "does-not-exist", {
        repo,
        entitlements: async () => entitlementsFor("free"),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
