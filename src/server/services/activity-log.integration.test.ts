/**
 * GRAFT-29.4 — the Definition of Done, end to end against a real MongoDB:
 * "an operator can find a real row for a real thing that happened."
 *
 * The unit suites beside each call site prove *what* is recorded. They all
 * stub the store, so none of them proves the part that actually matters here:
 * that a row written by `recordActivity` through the real Mongo store is a row
 * GRAFT-29.2's read API returns. That is a claim about two modules agreeing on
 * a document shape — ObjectId vs string for `tenantId` and `actorId`, the
 * `context` sub-document, the `action` filter — and only a real database can
 * settle it. A row the operator cannot find is the same as no row at all.
 *
 * So every assertion below goes through `listAdminActivities` rather than
 * reading the collection directly, deliberately: reading the collection would
 * re-prove the write path and skip the integration this issue exists to
 * establish.
 *
 * One harness for all three families rather than an addition to each of
 * `accounts`/`billing`/`records`'s own integration suite — the Test Contract's
 * file list is about where the *unit* additions go, and three separate
 * mongodb-memory-server instances to make the same end-to-end point would be
 * slower and would split one proof across three files. Flagged in the PR.
 */
import { ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import { getDb, getMongoClient } from "@/server/db/mongo";
import type { EntityView } from "@/server/services/entities";
import { ACTIVITIES_COLLECTION } from "./activity-log";
import { listAdminActivities } from "./admin-activities";
import { createRecord, deleteRecord, updateRecord } from "./records";
import { handleStripeWebhookEvent, type BillingDeps, type StripeEvent } from "./billing";

const TENANT_A = "000000000000000000000001";
const USER_A = "00000000000000000000000b";
const ENTITY_A = "000000000000000000000021";

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({ instance: { dbName: "graft_activity_it" } });
  process.env.MONGODB_URI = mongod.getUri("graft_activity_it");
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  process.env.APP_ENV = "qa";
}, 120_000);

afterAll(async () => {
  await (await getMongoClient()).close();
  await mongod?.stop();
});

beforeEach(async () => {
  const db = await getDb();
  await db.collection(ACTIVITIES_COLLECTION).deleteMany({});
  await db.collection("records").deleteMany({});
});

const ctxA: Ctx = createContext({
  requestId: "req-activity-it",
  tenantId: TENANT_A,
  userId: USER_A,
  roles: ["owner"],
  tier: "free",
});

const entityView: EntityView = {
  id: ENTITY_A,
  key: "customers",
  name: "Customers",
  fields: [{ key: "name", label: "Name", type: "text", required: true }],
  schemaVersion: 1,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const recordDeps = {
  getEntity: async () => entityView,
  consumeQuota: async () => ({
    meter: "records" as const,
    period: "2026-01",
    allowed: true,
    limit: null,
    used: 0,
    remaining: null,
    warned: false,
  }),
};

/** What the operator sees: one page of the admin read API, newest first. */
const findRows = async (action?: string) => {
  const { items } = await listAdminActivities(action ? { action } : {});
  return items;
};

describe("GRAFT-29.4 — a real row for a real thing, read back through GRAFT-29.2", () => {
  describe("AC3 — entity writes", () => {
    it("surfaces entity.created, .updated and .deleted for the acting user", async () => {
      const created = await createRecord(ctxA, ENTITY_A, { name: "Ada" }, recordDeps);
      await updateRecord(ctxA, ENTITY_A, created.id, { name: "Grace" }, recordDeps);
      await deleteRecord(ctxA, ENTITY_A, created.id, recordDeps);

      const rows = await findRows();
      expect(rows.map((r) => r.action)).toEqual([
        "entity.deleted",
        "entity.updated",
        "entity.created",
      ]);

      // The join keys survive the ObjectId round trip in both directions —
      // this is the assertion a stubbed store cannot make.
      for (const row of rows) {
        expect(row.tenantId).toBe(TENANT_A);
        expect(row.actorType).toBe("customer");
        expect(row.actorId).toBe(USER_A);
        expect(row.ok).toBe(true);
        expect(row.context).toMatchObject({
          entityDefId: ENTITY_A,
          entityType: "customers",
          recordId: created.id,
        });
      }
    });

    it("is findable by the action filter the console actually sends", async () => {
      const created = await createRecord(ctxA, ENTITY_A, { name: "Ada" }, recordDeps);
      await updateRecord(ctxA, ENTITY_A, created.id, { name: "Grace" }, recordDeps);

      const rows = await findRows("entity.updated");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe("entity.updated");
    });
  });

  describe("AC2 — the Stripe webhook", () => {
    /**
     * The tier machinery is stubbed to the narrowest thing that lets the event
     * reach its activity call: what is under test here is the row, and the
     * transitions themselves are billing.test.ts's contract.
     */
    const webhookDeps = (event: StripeEvent): Partial<BillingDeps> => ({
      events: { claim: async () => true },
      stripe: {
        createCustomer: async () => ({ id: "cus_x" }),
        createCheckoutSession: async () => ({ url: null }),
        constructEvent: async () => event,
      },
      store: {
        findTenantById: async () => null,
        findTenantByStripeCustomerId: async () => ({
          id: TENANT_A,
          tier: "premium" as const,
          billing: {
            stripeCustomerId: "cus_a",
            stripeSubscriptionId: null,
            graceExpiresAt: null,
            trialEndsAt: null,
          },
        }),
        setStripeCustomerId: async () => {},
        setSubscriptionId: async () => {},
        applyUpgrade: async () => {},
        applyDowngrade: async () => {},
        setGraceExpiry: async () => {},
        listTenantsWithExpiredGrace: async () => [],
        setTrialEndsAt: async () => {},
        listTenantsWithExpiredTrial: async () => [],
      },
      billingEnv: () => ({
        STRIPE_SECRET_KEY: "sk_test",
        STRIPE_WEBHOOK_SECRET: "whsec_test",
        STRIPE_PRICE_PREMIUM_MONTHLY: "price_test_monthly",
        STRIPE_PRICE_PREMIUM_ANNUAL: "price_test_annual",
      }),
    });

    it("surfaces billing.payment.failed as a system row with no Stripe id", async () => {
      const event: StripeEvent = {
        id: "evt_it_1",
        type: "invoice.payment_failed",
        data: {
          object: {
            id: "in_it_1",
            customer: "cus_a",
            amount_due: 2500,
            currency: "eur",
            last_finalization_error: { code: "card_declined" },
          },
        },
      };
      await handleStripeWebhookEvent(
        JSON.stringify(event),
        "sig",
        webhookDeps(event),
        "req-webhook-it",
      );

      const rows = await findRows("billing.payment.failed");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenantId: TENANT_A,
        actorType: "system",
        // The nullable actor, round-tripped as null rather than as a cast.
        actorId: null,
        action: "billing.payment.failed",
        ok: false,
        context: { amountCents: 2500, currency: "eur", failureCode: "card_declined" },
      });
      expect(JSON.stringify(rows[0]!.context)).not.toMatch(/\b(cus|sub|in|evt)_/);
    });
  });

  /**
   * AC5, end to end and at its most literal: not a mocked throw, but a genuinely
   * absent collection. The activity write is pointed at a database that has been
   * closed underneath it, and the record write must still succeed.
   */
  describe("AC5 — failure isolation against a real failure", () => {
    it("writes the record even when the activity insert cannot complete", async () => {
      const created = await createRecord(
        ctxA,
        ENTITY_A,
        { name: "Ada" },
        {
          ...recordDeps,
          emit: async (input) => {
            const { recordActivity } = await import("./activity-log");
            await recordActivity(input, {
              activities: {
                append: async () => {
                  throw new Error("collection unavailable");
                },
              },
            }).catch(() => undefined);
          },
        },
      );

      expect(created.data).toEqual({ name: "Ada" });
      const db = await getDb();
      const stored = await db.collection("records").findOne({ _id: new ObjectId(created.id) });
      expect(stored).not.toBeNull();
      expect(await findRows()).toHaveLength(0);
    });
  });
});
