/**
 * Entitlement resolution (GRAFT-05 AC1, AC2, AC7, AC8).
 *
 * The tenant is a port so these rules are exercised as logic: what a per-tenant
 * override beats, what `null` means, and what a downgrade freezes. The Mongo
 * implementation of the same port is driven for real in
 * meters.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import { TIER_LIMITS, type Tier } from "@/server/tiers";
import {
  allows,
  assertWritable,
  can,
  isReadOnly,
  limitFor,
  loadEntitlements,
  resolveEntitlements,
  type EntitlementStore,
  type TenantSnapshot,
} from "./entitlements";

const TENANT = "000000000000000000000001";
const USER = "00000000000000000000000b";

const ctxFor = (tier: Tier = "free", tenantId = TENANT): Ctx =>
  createContext({ requestId: "req-ent", tenantId, userId: USER, roles: ["owner"], tier });

const snapshot = (over: Partial<TenantSnapshot> = {}): TenantSnapshot => ({
  id: TENANT,
  tier: "free",
  limits: { ...TIER_LIMITS.free },
  readOnly: [],
  downgradedAt: null,
  billingAnchorDay: 1,
  ...over,
});

const storeOf = (tenant: TenantSnapshot | null): EntitlementStore => ({
  findTenant: async (tenantId) => (tenant && tenant.id === tenantId ? tenant : null),
});

describe("feature gating (AC1)", () => {
  it("csv_import is off on Free and on for Premium", async () => {
    const free = await can(ctxFor("free"), "csv_import", { store: storeOf(snapshot()) });
    expect(free).toBe(false);

    const premium = await can(ctxFor("premium"), "csv_import", {
      store: storeOf(snapshot({ tier: "premium", limits: { ...TIER_LIMITS.premium } })),
    });
    expect(premium).toBe(true);
  });

  it("reads the tenant document, not ctx.tier — a stale token cannot grant a feature", async () => {
    // The access token says premium; the tenant was downgraded a minute ago.
    const entitlements = await loadEntitlements(ctxFor("premium"), {
      store: storeOf(snapshot({ tier: "free" })),
    });
    expect(entitlements.tier).toBe("free");
    expect(allows(entitlements, "csv_import")).toBe(false);
  });

  it("a per-tenant feature grant beats the tier default (AC2)", async () => {
    // The Enterprise deal that ships without a code change: a Free-tier tenant
    // with csv_import written onto tenants.limits.
    const store = storeOf(
      snapshot({
        limits: { ...TIER_LIMITS.free, csv_import: true } as TenantSnapshot["limits"],
      }),
    );
    expect(await can(ctxFor("free"), "csv_import", { store })).toBe(true);
  });

  it("ignores unknown and wrongly typed keys on the tenant document", async () => {
    const store = storeOf(
      snapshot({
        limits: {
          ...TIER_LIMITS.free,
          csv_import: "yes",
          $where: "1",
          records: "lots",
        } as unknown as TenantSnapshot["limits"],
      }),
    );
    const entitlements = await loadEntitlements(ctxFor(), { store });
    expect(allows(entitlements, "csv_import")).toBe(false);
    expect(entitlements.limits.records).toBe(TIER_LIMITS.free.records);
    expect(Object.keys(entitlements.limits)).not.toContain("$where");
  });

  it("a tenant that no longer exists is forbidden, not entitled", async () => {
    await expect(loadEntitlements(ctxFor(), { store: storeOf(null) })).rejects.toBeInstanceOf(
      AppError,
    );
  });
});

describe("limit resolution (AC2, AC8)", () => {
  it("a numeric per-tenant override beats the tier default", () => {
    const entitlements = resolveEntitlements(
      snapshot({ limits: { ...TIER_LIMITS.free, records: 50_000 } }),
    );
    expect(limitFor(entitlements, "records")).toBe(50_000);
    // Untouched keys still come from the tier matrix.
    expect(limitFor(entitlements, "entities")).toBe(TIER_LIMITS.free.entities);
  });

  it("null means unlimited and is never read as zero (AC8)", () => {
    const entitlements = resolveEntitlements(
      snapshot({ limits: { ...TIER_LIMITS.free, submissionsPerMonth: null } }),
    );
    expect(limitFor(entitlements, "submissionsPerMonth")).toBeNull();
    // Enterprise is mostly nulls — none of them may collapse to 0.
    const enterprise = resolveEntitlements(
      snapshot({ tier: "enterprise", limits: { ...TIER_LIMITS.enterprise } }),
    );
    expect(limitFor(enterprise, "records")).toBeNull();
    expect(limitFor(enterprise, "seats")).toBeNull();
  });

  it("an explicit zero override is honoured as zero, not as unlimited", () => {
    const entitlements = resolveEntitlements(
      snapshot({ limits: { ...TIER_LIMITS.free, activeForms: 0 } }),
    );
    expect(limitFor(entitlements, "activeForms")).toBe(0);
  });

  it("a negative or fractional override is rejected in favour of the tier default", () => {
    const entitlements = resolveEntitlements(
      snapshot({ limits: { ...TIER_LIMITS.free, records: -1, entities: 2.5 } }),
    );
    expect(limitFor(entitlements, "records")).toBe(TIER_LIMITS.free.records);
    expect(limitFor(entitlements, "entities")).toBe(TIER_LIMITS.free.entities);
  });

  it("a tenant with no materialised limits falls back to the tier matrix", () => {
    const entitlements = resolveEntitlements(
      snapshot({ tier: "premium", limits: undefined as unknown as TenantSnapshot["limits"] }),
    );
    expect(limitFor(entitlements, "records")).toBe(TIER_LIMITS.premium.records);
  });
});

describe("downgrade state (AC7)", () => {
  it("a frozen resource is read-only, and everything else stays writable", () => {
    const entitlements = resolveEntitlements(
      snapshot({ readOnly: ["records", "entities"], downgradedAt: new Date() }),
    );
    expect(isReadOnly(entitlements, "records")).toBe(true);
    expect(isReadOnly(entitlements, "entities")).toBe(true);
    expect(isReadOnly(entitlements, "form_submissions")).toBe(false);
  });

  it("assertWritable raises QUOTA_EXCEEDED on a frozen resource only", () => {
    const entitlements = resolveEntitlements(snapshot({ readOnly: ["records"] }));
    expect(() => assertWritable(entitlements, "form_submissions")).not.toThrow();
    try {
      assertWritable(entitlements, "records");
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("QUOTA_EXCEEDED");
    }
  });

  it("a non-array readOnly field cannot freeze anything", () => {
    const entitlements = resolveEntitlements(
      snapshot({ readOnly: "records" as unknown as string[] }),
    );
    expect(isReadOnly(entitlements, "records")).toBe(false);
  });
});
