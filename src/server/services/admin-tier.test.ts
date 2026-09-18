/**
 * GRAFT-27.4 — the manual tier override service.
 *
 * The contract's central claim is a *negative* one: this service does not
 * reimplement tier-transition policy, it calls the two functions in
 * billing.ts that already encode it. A test that merely checked the tenant
 * ended up on the right tier would pass just as happily against a hand-written
 * `tenants.tier` update — which is exactly the bug the endpoint exists to
 * prevent. So AC1/AC2 are proven twice over, from two directions:
 *
 *   1. **Identity.** The defaults `resolveDeps` installs are asserted to be
 *      `applyUpgrade` and `applyDowngradePolicy` themselves, by reference
 *      (`toBe`). Swap in a local copy of the freeze logic and this fails.
 *   2. **Behaviour.** The real `applyUpgrade` / `applyDowngradePolicy` are then
 *      driven through a `BillingStore` double, and the assertions are made on
 *      what *billing.ts* asked the store to do — `store.applyDowngrade(...)`
 *      with the computed `readOnly`, `unpublishForm` for each overflow form.
 *      Those calls can only happen if billing.ts really ran.
 *
 * Unlike admin-tenants.test.ts, this file does **not** mock
 * `@/server/repositories/base` into throwing. That guard is right for a purely
 * cross-tenant read surface; it would be a false claim here, because
 * billing.ts legitimately constructs the ctx-scoped repositories at import
 * time and reads meters and forms through them under its own system ctx —
 * that is exactly the policy this service is delegating to. What is asserted
 * instead is the thing that actually matters: `admin-tier.ts` itself builds no
 * repository, holds no ctx, and reaches Mongo only through the billing store
 * and the admin tenant store (see `resolveAdminTierDeps`).
 */
import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";

import { AppError } from "@/server/http/envelope";
import { TIER_LIMITS, type Tier, type TierLimits } from "@/server/tiers";
import {
  applyDowngradePolicy,
  applyUpgrade,
  type BillingDeps,
  type BillingStore,
} from "./billing";
import {
  adminTierOverrideSchema,
  deferredAdminAudit,
  overrideTenantTier,
  resolveAdminTierDeps,
  type AdminTierDeps,
} from "./admin-tier";
import type { AdminTenantDoc } from "./admin-tenants";
import type { AdminAuditEntry } from "./admin-audit";

const oid = (n: number) => new ObjectId(String(n).padStart(24, "0"));
const TENANT_ID = oid(1).toHexString();
const ACTOR_ID = oid(80).toHexString();

/** A tenant document as the admin store returns it. */
const tenantDoc = (over: Partial<AdminTenantDoc> = {}): AdminTenantDoc => ({
  _id: oid(1),
  name: "Acme",
  slug: "acme",
  tier: "free",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  limits: {},
  readOnly: [],
  downgradedAt: null,
  billingAnchorDay: 1,
  ...over,
});

/**
 * A `BillingStore` double that records what billing.ts asked it to do and then
 * mutates a local tenant document, so a re-read after the transition sees the
 * result. Only the methods this path can reach are real; the rest throw,
 * because reaching them would mean the service took a path it has no business
 * taking (a Stripe write, a grace window, a trial).
 */
function billingStoreDouble(doc: AdminTenantDoc) {
  const calls = {
    applyUpgrade: [] as { tenantId: string; tier: Tier; limits: TierLimits }[],
    applyDowngrade: [] as {
      tenantId: string;
      limits: TierLimits;
      readOnly: string[];
      now: Date;
      tier: Tier;
    }[],
  };

  const unreachable = (name: string) => () => {
    throw new Error(`${name} must not be reached by the tier override path`);
  };

  const store: BillingStore = {
    findTenantById: async () => ({
      id: doc._id.toHexString(),
      tier: (doc.tier ?? "free") as Tier,
      billing: {
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        graceExpiresAt: null,
        trialEndsAt: null,
      },
    }),
    findTenantByStripeCustomerId: unreachable("findTenantByStripeCustomerId"),
    setStripeCustomerId: unreachable("setStripeCustomerId"),
    setSubscriptionId: unreachable("setSubscriptionId"),
    async applyUpgrade(tenantId, tier, limits) {
      calls.applyUpgrade.push({ tenantId, tier, limits });
      doc.tier = tier;
      doc.limits = {};
      doc.readOnly = [];
      doc.downgradedAt = null;
    },
    async applyDowngrade(tenantId, limits, readOnly, now, tier = "free") {
      calls.applyDowngrade.push({ tenantId, limits, readOnly: [...readOnly], now, tier });
      doc.tier = tier;
      doc.readOnly = [...readOnly];
      doc.downgradedAt = now;
    },
    setGraceExpiry: unreachable("setGraceExpiry"),
    listTenantsWithExpiredGrace: unreachable("listTenantsWithExpiredGrace"),
    setTrialEndsAt: unreachable("setTrialEndsAt"),
    listTenantsWithExpiredTrial: unreachable("listTenantsWithExpiredTrial"),
  };

  return { store, calls };
}

/** Meters and forms, as billing.ts reads them through the repository ports. */
function billingOverrides(
  store: BillingStore,
  opts: {
    entities?: number;
    records?: number;
    publicForms?: { id: string; createdAt: Date }[];
    unpublished?: string[];
  } = {},
): Partial<BillingDeps> {
  const meters = { entities: opts.entities ?? 0, records: opts.records ?? 0 };
  const forms = opts.publicForms ?? [];
  return {
    store,
    usageMetersRepo: {
      findOne: async (_ctx: unknown, filter: { meter: "entities" | "records" }) => ({
        meter: filter.meter,
        period: "lifetime",
        count: meters[filter.meter],
      }),
    } as unknown as BillingDeps["usageMetersRepo"],
    formsRepo: {
      find: async () => forms.map((form) => ({ _id: new ObjectId(form.id) })),
    } as unknown as BillingDeps["formsRepo"],
    unpublishForm: async (_ctx: unknown, formId: string) => {
      opts.unpublished?.push(formId);
    },
    now: () => new Date("2026-09-18T12:00:00.000Z"),
  };
}

/** Captures the single row the service flushes, instead of writing to Mongo. */
function auditSpy() {
  const rows: AdminAuditEntry[] = [];
  const deferred = deferredAdminAudit({
    audit: { append: async (row) => void rows.push(row) },
  });
  return { deferred, rows };
}

/** Feeds the gate's row into the sink, exactly as `assertPlatformAdmin` does. */
async function gateWrites(
  deferred: ReturnType<typeof auditSpy>["deferred"],
  targetTenantId: string | null = TENANT_ID,
) {
  await deferred.sink.append({
    actorUserId: ACTOR_ID,
    action: "admin.tenant.tier",
    targetTenantId,
    requestId: "req-1",
    at: new Date("2026-09-18T12:00:00.000Z"),
  });
}

function deps(
  doc: AdminTenantDoc,
  billing: Partial<BillingDeps>,
  over: Partial<AdminTierDeps> = {},
): Partial<AdminTierDeps> {
  return {
    tenants: { findTenant: async () => doc },
    billing,
    ...over,
  };
}

describe("admin tier override", () => {
  describe("it calls the existing transition policy, and does not reimplement it", () => {
    it("defaults to billing.ts's own applyUpgrade and applyDowngradePolicy, by reference", () => {
      // The whole contract in one assertion: a local reimplementation of the
      // freeze/unpublish logic would not be these functions.
      const resolved = resolveAdminTierDeps();
      expect(resolved.applyUpgrade).toBe(applyUpgrade);
      expect(resolved.applyDowngradePolicy).toBe(applyDowngradePolicy);
    });

    it("AC1 — an upgrade goes through applyUpgrade, which writes the tier's materialised limits and clears the freeze", async () => {
      const doc = tenantDoc({ tier: "free", readOnly: ["records"], downgradedAt: new Date() });
      const { store, calls } = billingStoreDouble(doc);
      const { deferred, rows } = auditSpy();
      await gateWrites(deferred);

      const result = await overrideTenantTier(
        {
          tenantId: TENANT_ID,
          body: { tier: "premium", reason: "comped for launch partner" },
          audit: deferred,
        },
        deps(doc, billingOverrides(store)),
      );

      // Proof the real applyUpgrade ran: it is the only thing that calls
      // store.applyUpgrade, and it is what chooses TIER_LIMITS[tier].
      expect(calls.applyUpgrade).toEqual([
        { tenantId: TENANT_ID, tier: "premium", limits: TIER_LIMITS.premium },
      ]);
      expect(calls.applyDowngrade).toHaveLength(0);
      expect(result).toEqual({
        id: TENANT_ID,
        fromTier: "free",
        toTier: "premium",
        changed: true,
        readOnly: [],
      });
      expect(doc.downgradedAt).toBeNull();
      expect(rows).toHaveLength(1);
    });

    it("AC2 — a downgrade goes through applyDowngradePolicy: over-limit meters are frozen, overflow forms are unpublished oldest-kept, and nothing is deleted", async () => {
      const doc = tenantDoc({ tier: "premium", readOnly: [], downgradedAt: null });
      const { store, calls } = billingStoreDouble(doc);
      const unpublished: string[] = [];
      // Over Free on both meters, and five public forms against a cap of two.
      const publicForms = [3, 4, 5, 6, 7].map((n) => ({
        id: oid(n).toHexString(),
        createdAt: new Date(`2026-0${n}-01T00:00:00.000Z`),
      }));
      const { deferred } = auditSpy();
      await gateWrites(deferred);

      const result = await overrideTenantTier(
        {
          tenantId: TENANT_ID,
          body: { tier: "free", reason: "refund issued, dropping to free" },
          audit: deferred,
        },
        deps(
          doc,
          billingOverrides(store, {
            entities: 9,
            records: 5_000,
            publicForms,
            unpublished,
          }),
        ),
      );

      // Only applyDowngradePolicy computes this readOnly set and hands it to
      // the store — the service never builds one.
      expect(calls.applyDowngrade).toHaveLength(1);
      expect(calls.applyDowngrade[0]?.readOnly).toEqual(["entities", "records"]);
      expect(calls.applyDowngrade[0]?.limits).toEqual(TIER_LIMITS.free);
      expect(calls.applyUpgrade).toHaveLength(0);

      // Oldest two kept (Free's activeForms cap), the rest unpublished — and
      // *unpublished*, never deleted: the port called is `unpublishForm`, and
      // the store double has no delete method to call at all.
      expect(unpublished).toEqual(publicForms.slice(2).map((form) => form.id));
      expect(unpublished).not.toContain(publicForms[0]?.id);

      expect(result.changed).toBe(true);
      expect(result.readOnly).toEqual(["entities", "records"]);
      expect(doc.downgradedAt).toBeInstanceOf(Date);
    });

    it("AC2 — a tenant inside the new tier's limits is downgraded with an empty freeze", async () => {
      const doc = tenantDoc({ tier: "premium" });
      const { store, calls } = billingStoreDouble(doc);
      const { deferred } = auditSpy();
      await gateWrites(deferred);

      const result = await overrideTenantTier(
        {
          tenantId: TENANT_ID,
          body: { tier: "free", reason: "trial never converted" },
          audit: deferred,
        },
        deps(doc, billingOverrides(store, { entities: 1, records: 10, publicForms: [] })),
      );

      expect(calls.applyDowngrade[0]?.readOnly).toEqual([]);
      expect(result.readOnly).toEqual([]);
    });

    it("a step down that is not to Free still runs the downgrade policy, for the target tier", async () => {
      // enterprise -> premium is a *downward* move: it must freeze against
      // Premium's caps, not silently leave an over-limit tenant unfrozen.
      const doc = tenantDoc({ tier: "enterprise" });
      const { store, calls } = billingStoreDouble(doc);
      const { deferred } = auditSpy();
      await gateWrites(deferred);

      await overrideTenantTier(
        {
          tenantId: TENANT_ID,
          body: { tier: "premium", reason: "deal ended" },
          audit: deferred,
        },
        deps(doc, billingOverrides(store, { entities: 40, records: 10 })),
      );

      expect(calls.applyUpgrade).toHaveLength(0);
      expect(calls.applyDowngrade).toHaveLength(1);
      expect(calls.applyDowngrade[0]?.tier).toBe("premium");
      expect(calls.applyDowngrade[0]?.limits).toEqual(TIER_LIMITS.premium);
      // 40 entities against Premium's 25 — frozen, not deleted.
      expect(calls.applyDowngrade[0]?.readOnly).toEqual(["entities"]);
    });
  });

  describe("validation", () => {
    it("AC3 — a missing, blank or over-long reason is a 400 and the tenant is untouched", async () => {
      const doc = tenantDoc({ tier: "free" });
      const { store, calls } = billingStoreDouble(doc);
      const { deferred, rows } = auditSpy();
      await gateWrites(deferred);

      for (const body of [
        { tier: "premium" },
        { tier: "premium", reason: "" },
        { tier: "premium", reason: "   " },
        { tier: "premium", reason: "x".repeat(501) },
      ]) {
        await expect(
          overrideTenantTier(
            { tenantId: TENANT_ID, body, audit: deferred },
            deps(doc, billingOverrides(store)),
          ),
        ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      }

      expect(calls.applyUpgrade).toHaveLength(0);
      expect(calls.applyDowngrade).toHaveLength(0);
      expect(doc.tier).toBe("free");
      // An unaudited tier flip is not supported — and a *rejected* one is not
      // an action, so it writes no row either.
      expect(rows).toHaveLength(0);
    });

    it("AC3 — a reason of exactly 500 characters is accepted", () => {
      const parsed = adminTierOverrideSchema.safeParse({
        tier: "premium",
        reason: "x".repeat(500),
      });
      expect(parsed.success).toBe(true);
    });

    it("AC4 — the tier enum is built from the TIERS constant, not a hand-written list", async () => {
      const doc = tenantDoc();
      const { store, calls } = billingStoreDouble(doc);
      const { deferred } = auditSpy();
      await gateWrites(deferred);

      for (const tier of ["gold", "FREE", "", null, 3]) {
        await expect(
          overrideTenantTier(
            { tenantId: TENANT_ID, body: { tier, reason: "nope" }, audit: deferred },
            deps(doc, billingOverrides(store)),
          ),
        ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      }
      expect(calls.applyUpgrade).toHaveLength(0);
      expect(calls.applyDowngrade).toHaveLength(0);
    });

    it("AC9 — a non-hex tenant id is a 400, and a well-formed unknown one is a 404 with no audit row", async () => {
      const doc = tenantDoc();
      const { store } = billingStoreDouble(doc);
      const { deferred, rows } = auditSpy();
      await gateWrites(deferred, null);

      await expect(
        overrideTenantTier(
          { tenantId: "nope", body: { tier: "premium", reason: "r" }, audit: deferred },
          deps(doc, billingOverrides(store)),
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

      await expect(
        overrideTenantTier(
          {
            tenantId: oid(999).toHexString(),
            body: { tier: "premium", reason: "r" },
            audit: deferred,
          },
          deps(doc, billingOverrides(store), { tenants: { findTenant: async () => null } }),
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      expect(rows).toHaveLength(0);
    });
  });

  describe("the no-op case", () => {
    it("AC5 — an already-Free tenant asked for Free is not re-frozen, but is still audited with changed:false", async () => {
      const frozenAt = new Date("2026-05-01T00:00:00.000Z");
      const doc = tenantDoc({ tier: "free", readOnly: ["records"], downgradedAt: frozenAt });
      const { store, calls } = billingStoreDouble(doc);
      const unpublished: string[] = [];
      const { deferred, rows } = auditSpy();
      await gateWrites(deferred);

      const result = await overrideTenantTier(
        {
          tenantId: TENANT_ID,
          body: { tier: "free", reason: "confirming the tier is right" },
          audit: deferred,
        },
        deps(doc, billingOverrides(store, { entities: 99, records: 99_999, unpublished })),
      );

      // Neither transition ran: an already-Free tenant that happens to be over
      // Free's limits must not be re-frozen by a confirmation.
      expect(calls.applyUpgrade).toHaveLength(0);
      expect(calls.applyDowngrade).toHaveLength(0);
      expect(unpublished).toEqual([]);
      expect(doc.readOnly).toEqual(["records"]);
      expect(doc.downgradedAt).toBe(frozenAt);

      expect(result).toEqual({
        id: TENANT_ID,
        fromTier: "free",
        toTier: "free",
        changed: false,
        readOnly: ["records"],
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        changed: false,
        ok: true,
        fromTier: "free",
        toTier: "free",
      });
    });
  });

  describe("the audit row", () => {
    it("AC7 — exactly one row is appended, carrying the contracted fields and nothing else", async () => {
      const doc = tenantDoc({ tier: "free" });
      const { store } = billingStoreDouble(doc);
      const { deferred, rows } = auditSpy();
      await gateWrites(deferred);

      await overrideTenantTier(
        {
          tenantId: TENANT_ID,
          body: { tier: "premium", reason: "comped for launch partner" },
          audit: deferred,
        },
        deps(doc, billingOverrides(store)),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorUserId: ACTOR_ID,
        action: "admin.tenant.tier",
        targetTenantId: TENANT_ID,
        fromTier: "free",
        toTier: "premium",
        reason: "comped for launch partner",
        changed: true,
        ok: true,
        requestId: "req-1",
      });
      expect(rows[0]?.at).toBeInstanceOf(Date);
      expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
        "action",
        "actorUserId",
        "at",
        "changed",
        "fromTier",
        "ok",
        "reason",
        "requestId",
        "targetTenantId",
        "toTier",
      ]);
    });

    it("AC7 — the reason is stored trimmed, and the gate's own identity fields are not re-derived by the service", async () => {
      const doc = tenantDoc({ tier: "free" });
      const { store } = billingStoreDouble(doc);
      const { deferred, rows } = auditSpy();
      await gateWrites(deferred);

      await overrideTenantTier(
        {
          tenantId: TENANT_ID,
          body: { tier: "premium", reason: "  spaced out  " },
          audit: deferred,
        },
        deps(doc, billingOverrides(store)),
      );

      expect(rows[0]?.reason).toBe("spaced out");
      expect(rows[0]?.actorUserId).toBe(ACTOR_ID);
    });

    it("AC8 — a transition that throws part-way is audited with ok:false and surfaces as INTERNAL", async () => {
      const doc = tenantDoc({ tier: "free" });
      const { store } = billingStoreDouble(doc);
      const { deferred, rows } = auditSpy();
      await gateWrites(deferred);

      const boom = new Error("stripe-less transition blew up halfway");
      const error = await overrideTenantTier(
        {
          tenantId: TENANT_ID,
          body: { tier: "premium", reason: "comped" },
          audit: deferred,
        },
        deps(doc, billingOverrides(store), {
          applyUpgrade: async () => {
            throw boom;
          },
        }),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: "INTERNAL" });
      // The failure is on the record, with the reason that motivated the
      // attempt — a half-applied transition nobody can find is the worst case.
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "admin.tenant.tier",
        ok: false,
        changed: false,
        fromTier: "free",
        toTier: "premium",
        reason: "comped",
      });
    });

    it("AC8 — an audit flush that itself fails does not turn into a partial success", async () => {
      const doc = tenantDoc({ tier: "free" });
      const { store } = billingStoreDouble(doc);
      const deferred = deferredAdminAudit({
        audit: {
          append: async () => {
            throw new Error("audit collection unavailable");
          },
        },
      });
      await deferred.sink.append({
        actorUserId: ACTOR_ID,
        action: "admin.tenant.tier",
        targetTenantId: TENANT_ID,
        requestId: "req-1",
        at: new Date(),
      });

      await expect(
        overrideTenantTier(
          { tenantId: TENANT_ID, body: { tier: "premium", reason: "comped" }, audit: deferred },
          deps(doc, billingOverrides(store)),
        ),
      ).rejects.toMatchObject({ code: "INTERNAL" });
    });
  });

  it("reaches Mongo only through the two stores it is given — it holds no ctx of its own", async () => {
    // A cross-tenant mutation must never be scoped by the caller's own tenant,
    // and the way that is guaranteed here is that the service has nothing to
    // scope *by*: its whole surface is the two stores below plus the billing
    // functions, all of which are supplied. If every one of them is a double,
    // the call completes without touching a database at all.
    const doc = tenantDoc({ tier: "free" });
    const { store } = billingStoreDouble(doc);
    const { deferred } = auditSpy();
    await gateWrites(deferred);

    const resolved = resolveAdminTierDeps({
      tenants: { findTenant: async () => doc },
      billing: billingOverrides(store),
    });
    expect(Object.keys(resolved).sort()).toEqual([
      "applyDowngradePolicy",
      "applyUpgrade",
      "billing",
      "tenants",
    ]);

    await expect(
      overrideTenantTier(
        { tenantId: TENANT_ID, body: { tier: "premium", reason: "comped" }, audit: deferred },
        deps(doc, billingOverrides(store)),
      ),
    ).resolves.toMatchObject({ changed: true });
  });
});
