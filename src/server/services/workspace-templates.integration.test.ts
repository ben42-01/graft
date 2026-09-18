/**
 * Workspace templates against a real MongoDB — nothing mocked. The unit tests
 * prove the orchestration; this proves the ten blueprints survive the real
 * entities, records, inventory, forms and meters services, on a Free tenant,
 * and that re-applying after deleting a template's entity is not blocked by
 * the deleted row's key (migrations/003).
 *
 * mongodb-memory-server rather than the QA docker stack, for the same reason
 * as plugins.integration.test.ts: CI runs this before the QA stack exists.
 */
import { ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  findWorkspaceTemplate,
  resolveTemplate,
  WORKSPACE_TEMPLATES,
} from "@/lib/workspace-templates";
import { createContext, type Ctx } from "@/server/context";
import { getDb, getMongoClient } from "@/server/db/mongo";
import { TIER_LIMITS } from "@/server/tiers";
import { deleteEntity } from "./entities";
import { applyWorkspaceTemplate, previewWorkspaceTemplate } from "./workspace-templates";

const TENANT = "000000000000000000000001";
const tenantId = new ObjectId(TENANT);

const ctx: Ctx = createContext({
  requestId: "req-templates-it",
  tenantId: TENANT,
  userId: "00000000000000000000000b",
  roles: ["owner"],
  tier: "free",
});

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ instance: { dbName: "graft_templates_it" } });
  process.env.MONGODB_URI = mongod.getUri("graft_templates_it");
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  process.env.APP_ENV = "qa";

  // The production index definitions that matter here (scripts/create-indexes.ts).
  const db = await getDb();
  await db
    .collection("entity_defs")
    .createIndex(
      { tenantId: 1, key: 1 },
      { unique: true, partialFilterExpression: { deletedAt: null } },
    );
  await db
    .collection("forms")
    .createIndex(
      { tenantId: 1, slug: 1 },
      { unique: true, partialFilterExpression: { deletedAt: null } },
    );
  await db
    .collection("forms")
    .createIndex(
      { publicSlug: 1 },
      { unique: true, partialFilterExpression: { publicSlug: { $type: "string" } } },
    );
  await db
    .collection("inventory_pools")
    .createIndex({ tenantId: 1, recordId: 1 }, { unique: true });
  await db
    .collection("usage_meters")
    .createIndex({ tenantId: 1, meter: 1, period: 1 }, { unique: true });
}, 60_000);

afterAll(async () => {
  await (await getMongoClient()).close();
  await mongod?.stop();
});

beforeEach(async () => {
  const db = await getDb();
  for (const name of [
    "tenants",
    "entity_defs",
    "records",
    "inventory_pools",
    "forms",
    "usage_meters",
    "template_runs",
  ]) {
    await db.collection(name).deleteMany({});
  }
  await db.collection("tenants").insertOne({
    _id: tenantId,
    name: "Acme",
    slug: "acme",
    tier: "free",
    limits: TIER_LIMITS.free,
    billingAnchorDay: 1,
    createdAt: new Date(),
  });
});

const fullAnswers = {
  depositPercent: 25,
  paymentLink: "https://buy.stripe.com/test_abc",
  termsUrl: "https://example.com/terms",
};

describe("applyWorkspaceTemplate against real services", () => {
  it.each(WORKSPACE_TEMPLATES.map((template) => [template.id] as const))(
    "%s applies cleanly on a fresh Free tenant",
    async (templateId) => {
      const result = await applyWorkspaceTemplate(ctx, templateId, { answers: fullAnswers });
      expect(result.status).toBe("completed");

      const db = await getDb();
      const entities = await db.collection("entity_defs").countDocuments({ tenantId });
      const forms = await db.collection("forms").find({ tenantId }).toArray();
      const pools = await db.collection("inventory_pools").countDocuments({ tenantId });
      expect(entities).toBe(result.entities.length);
      expect(forms).toHaveLength(result.forms.length);
      expect(pools).toBe(result.pools);

      // Each stored form carries exactly what its plan said it would.
      const plan = resolveTemplate(findWorkspaceTemplate(templateId)!, fullAnswers);
      for (const planned of plan.forms) {
        const stored = forms.find((form) => form.name === planned.name)!;
        expect(stored, planned.ref).toBeDefined();
        expect(stored.published).toBe(planned.publish);
        if (planned.publish) expect(stored.publicSlug).toMatch(/^acme\//);
        expect(stored.payment === null, `${planned.ref} payment`).toBe(
          planned.payment === null,
        );
        expect(stored.booking?.depositPercent ?? null).toBe(
          planned.booking?.depositPercent ?? null,
        );
        expect(stored.content).toHaveLength(planned.content.length);
      }
    },
  );

  it("refuses a second full template on Free before creating anything more", async () => {
    await applyWorkspaceTemplate(ctx, "hotel", {});
    const db = await getDb();
    const before = await db.collection("entity_defs").countDocuments({ tenantId });

    await expect(applyWorkspaceTemplate(ctx, "salon", {})).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });
    expect(await db.collection("entity_defs").countDocuments({ tenantId })).toBe(before);
  });

  it("suffixes names on a second apply rather than colliding", async () => {
    const premium = createContext({ ...ctx, tier: "premium" });
    const db = await getDb();
    await db
      .collection("tenants")
      .updateOne({ _id: tenantId }, { $set: { tier: "premium", limits: TIER_LIMITS.premium } });

    await applyWorkspaceTemplate(premium, "hotel", {});
    const preview = await previewWorkspaceTemplate(premium, "hotel", {});
    expect(preview.plan.entities.map((entity) => entity.key)).toEqual([
      "rooms_2",
      "reservations_2",
    ]);
    const second = await applyWorkspaceTemplate(premium, "hotel", {});
    expect(second.forms[0]!.slug).toBe("book-a-room-2");
  });

  it("re-applies under the original key after the template's entity is deleted", async () => {
    const premium = createContext({ ...ctx, tier: "premium" });
    const db = await getDb();
    await db
      .collection("tenants")
      .updateOne({ _id: tenantId }, { $set: { tier: "premium", limits: TIER_LIMITS.premium } });

    const first = await applyWorkspaceTemplate(premium, "trades", {
      answers: { publish: false },
    });
    for (const entity of first.entities) await deleteEntity(premium, entity.id);

    const again = await applyWorkspaceTemplate(premium, "trades", {
      answers: { publish: false },
    });
    expect(again.entities.map((entity) => entity.key)).toEqual(["services", "quote_requests"]);
  });
});
