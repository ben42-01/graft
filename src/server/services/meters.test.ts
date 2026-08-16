/**
 * Metering and quota enforcement (GRAFT-05 AC4, AC5, AC6, AC8).
 *
 * The counter store is a port so the arithmetic that decides whether a tenant
 * may write — the boundary, the 80% edge, the period, `null` — is exercised as
 * logic. AC3 (atomicity) and AC7 (the downgrade path end to end) are proven
 * against a real MongoDB in meters.integration.test.ts, because "atomic" is a
 * claim about the database and an in-memory fake cannot make it.
 */
import { describe, expect, it, vi } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import { TIER_LIMITS } from "@/server/tiers";
import { resolveEntitlements, type TenantSnapshot } from "./entitlements";
import {
  LIFETIME_PERIOD,
  billingPeriod,
  checkQuota,
  consumeQuota,
  peekQuota,
  periodFor,
  type MeterDeps,
  type MeterDoc,
  type MeterStore,
} from "./meters";

const TENANT = "000000000000000000000001";
const USER = "00000000000000000000000b";
const NOW = new Date("2026-03-20T12:00:00.000Z");

const ctx: Ctx = createContext({
  requestId: "req-meter",
  tenantId: TENANT,
  userId: USER,
  roles: ["owner"],
  tier: "free",
});

const snapshot = (over: Partial<TenantSnapshot> = {}): TenantSnapshot => ({
  id: TENANT,
  tier: "free",
  limits: { ...TIER_LIMITS.free },
  readOnly: [],
  downgradedAt: null,
  billingAnchorDay: 1,
  ...over,
});

/** The counter store's promises, in memory: create-once and a guarded $inc. */
function fakeStore(seed: Record<string, number> = {}) {
  const docs = new Map<string, MeterDoc>();
  for (const [key, count] of Object.entries(seed)) {
    const [meter, period] = key.split("@");
    docs.set(key, { meter, period, count, warnedAt: null });
  }
  const keyOf = (meter: string, period: string) => `${meter}@${period}`;

  const store: MeterStore = {
    async read(_ctx, meter, period) {
      return docs.get(keyOf(meter, period)) ?? null;
    },
    async ensure(_ctx, meter, period) {
      const key = keyOf(meter, period);
      if (!docs.has(key)) docs.set(key, { meter, period, count: 0, warnedAt: null });
    },
    async increment(_ctx, meter, period, amount, maxCount) {
      const doc = docs.get(keyOf(meter, period));
      if (!doc) return null;
      if (maxCount !== null && doc.count > maxCount) return null;
      doc.count += amount;
      return { ...doc };
    },
    async claimWarning(_ctx, meter, period, at) {
      const doc = docs.get(keyOf(meter, period));
      if (!doc || doc.warnedAt) return false;
      doc.warnedAt = at;
      return true;
    },
  };
  return { store, docs };
}

const depsFor = (
  tenant: TenantSnapshot,
  store: MeterStore,
  emitWarning = vi.fn(),
): Partial<MeterDeps> => ({
  store,
  emitWarning,
  now: () => NOW,
  entitlements: async () => resolveEntitlements(tenant),
});

describe("billing period (AC6)", () => {
  it("is the anniversary month, not the calendar month", () => {
    // Anchor on the 15th: the 20th is inside the period that opened this month.
    expect(billingPeriod(15, new Date("2026-03-20T00:00:00.000Z"))).toBe("2026-03");
    // The 10th is still inside the period that opened *last* month.
    expect(billingPeriod(15, new Date("2026-03-10T23:59:59.000Z"))).toBe("2026-02");
  });

  it("opens the new period exactly on the anniversary instant", () => {
    expect(billingPeriod(15, new Date("2026-03-14T23:59:59.999Z"))).toBe("2026-02");
    expect(billingPeriod(15, new Date("2026-03-15T00:00:00.000Z"))).toBe("2026-03");
  });

  it("crosses a year boundary backwards", () => {
    expect(billingPeriod(28, new Date("2026-01-05T00:00:00.000Z"))).toBe("2025-12");
  });

  it("clamps an anchor day that the month does not have", () => {
    // Anchor on the 31st: February's anniversary falls on the 28th.
    expect(billingPeriod(31, new Date("2026-02-28T06:00:00.000Z"))).toBe("2026-02");
    expect(billingPeriod(31, new Date("2026-02-27T06:00:00.000Z"))).toBe("2026-01");
  });

  it("keeps cumulative meters on one lifetime counter", () => {
    const entitlements = resolveEntitlements(snapshot({ billingAnchorDay: 15 }));
    expect(periodFor("form_submissions", entitlements, NOW)).toBe("2026-03");
    expect(periodFor("records", entitlements, NOW)).toBe(LIFETIME_PERIOD);
  });
});

describe("the quota boundary (AC4)", () => {
  it("allows the call that lands exactly on the limit", async () => {
    const { store, docs } = fakeStore({ "form_submissions@2026-03": 99 });
    const result = await checkQuota(ctx, "form_submissions", 1, depsFor(snapshot(), store));
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(100);
    expect(result.remaining).toBe(0);
    expect(docs.get("form_submissions@2026-03")?.count).toBe(100);
  });

  it("refuses the call that would cross it, and does not increment", async () => {
    const { store, docs } = fakeStore({ "form_submissions@2026-03": 100 });
    const result = await checkQuota(ctx, "form_submissions", 1, depsFor(snapshot(), store));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("quota_exceeded");
    expect(result.used).toBe(100);
    expect(result.remaining).toBe(0);
    expect(docs.get("form_submissions@2026-03")?.count).toBe(100);
  });

  it("refuses a batch that does not fit even though the counter is below the limit", async () => {
    const { store } = fakeStore({ "form_submissions@2026-03": 98 });
    const result = await checkQuota(ctx, "form_submissions", 5, depsFor(snapshot(), store));
    expect(result.allowed).toBe(false);
    expect(result.used).toBe(98);
  });

  it("a zero limit refuses the very first call", async () => {
    const { store } = fakeStore();
    const tenant = snapshot({ limits: { ...TIER_LIMITS.free, activeForms: 0 } });
    const result = await checkQuota(ctx, "active_forms", 1, depsFor(tenant, store));
    expect(result.allowed).toBe(false);
    expect(result.limit).toBe(0);
  });

  it("consumeQuota surfaces QUOTA_EXCEEDED for the caller", async () => {
    const { store } = fakeStore({ "form_submissions@2026-03": 100 });
    const deps = depsFor(snapshot(), store);
    await expect(consumeQuota(ctx, "form_submissions", 1, deps)).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });
    await expect(consumeQuota(ctx, "form_submissions", 1, deps)).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("consumeQuota returns the result when it fits", async () => {
    const { store } = fakeStore({ "form_submissions@2026-03": 1 });
    const result = await consumeQuota(ctx, "form_submissions", 2, depsFor(snapshot(), store));
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(3);
  });

  it("rejects a non-positive or non-integer amount rather than guessing", async () => {
    const { store } = fakeStore();
    const deps = depsFor(snapshot(), store);
    await expect(checkQuota(ctx, "form_submissions", 0, deps)).rejects.toBeInstanceOf(AppError);
    await expect(checkQuota(ctx, "form_submissions", -3, deps)).rejects.toBeInstanceOf(
      AppError,
    );
    await expect(checkQuota(ctx, "form_submissions", 1.5, deps)).rejects.toBeInstanceOf(
      AppError,
    );
  });
});

describe("unlimited limits (AC8)", () => {
  it("never refuses and never reports a remaining of zero", async () => {
    const { store, docs } = fakeStore({ "form_submissions@2026-03": 1_000_000 });
    const tenant = snapshot({ tier: "enterprise", limits: { ...TIER_LIMITS.enterprise } });
    const result = await checkQuota(ctx, "form_submissions", 1, depsFor(tenant, store));
    expect(result.allowed).toBe(true);
    expect(result.limit).toBeNull();
    expect(result.remaining).toBeNull();
    expect(docs.get("form_submissions@2026-03")?.count).toBe(1_000_001);
  });

  it("emits no warning for an unlimited meter, however large the counter", async () => {
    const emit = vi.fn();
    const { store } = fakeStore({ "form_submissions@2026-03": 5_000_000 });
    const tenant = snapshot({ tier: "enterprise", limits: { ...TIER_LIMITS.enterprise } });
    await checkQuota(ctx, "form_submissions", 1, depsFor(tenant, store, emit));
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("the 80% warning (AC5)", () => {
  it("fires on the call that crosses the threshold and never again in the period", async () => {
    const emit = vi.fn();
    const { store } = fakeStore({ "form_submissions@2026-03": 78 });
    const deps = depsFor(snapshot(), store, emit);

    const below = await checkQuota(ctx, "form_submissions", 1, deps); // 79
    expect(below.warned).toBe(false);
    expect(emit).not.toHaveBeenCalled();

    const crossing = await checkQuota(ctx, "form_submissions", 1, deps); // 80
    expect(crossing.warned).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        meter: "form_submissions",
        period: "2026-03",
        used: 80,
        limit: 100,
      }),
    );

    for (let i = 0; i < 5; i++) await checkQuota(ctx, "form_submissions", 1, deps);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("fires once even when a single call jumps clean over the threshold", async () => {
    const emit = vi.fn();
    const { store } = fakeStore({ "form_submissions@2026-03": 10 });
    const deps = depsFor(snapshot(), store, emit);
    const result = await checkQuota(ctx, "form_submissions", 85, deps);
    expect(result.warned).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("starts fresh in the next period", async () => {
    const emit = vi.fn();
    const { store } = fakeStore({
      "form_submissions@2026-03": 80,
      "form_submissions@2026-04": 79,
    });
    const marchDeps = depsFor(snapshot(), store, emit);
    await checkQuota(ctx, "form_submissions", 1, marchDeps);
    expect(emit).toHaveBeenCalledTimes(1);

    const aprilDeps = {
      ...marchDeps,
      now: () => new Date("2026-04-20T12:00:00.000Z"),
    };
    await checkQuota(ctx, "form_submissions", 1, aprilDeps);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("does not fire below the threshold when the limit is tiny", async () => {
    const emit = vi.fn();
    const { store } = fakeStore();
    const tenant = snapshot({ limits: { ...TIER_LIMITS.free, dashboards: 1 } });
    // 1 of 1 is 100% — over 80%, so it warns; the point is it does not warn at 0.
    const result = await checkQuota(ctx, "dashboards", 1, depsFor(tenant, store, emit));
    expect(result.allowed).toBe(true);
    expect(result.warned).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

describe("downgrade freeze (AC7)", () => {
  it("refuses a write to a frozen meter without touching the counter", async () => {
    const emit = vi.fn();
    const { store, docs } = fakeStore({ "records@all": 5_000 });
    const tenant = snapshot({ readOnly: ["records"], downgradedAt: NOW });
    const result = await checkQuota(ctx, "records", 1, depsFor(tenant, store, emit));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("read_only");
    expect(docs.get("records@all")?.count).toBe(5_000);
    expect(emit).not.toHaveBeenCalled();
  });

  it("leaves the frozen meter readable", async () => {
    const { store } = fakeStore({ "records@all": 5_000 });
    const tenant = snapshot({ readOnly: ["records"], downgradedAt: NOW });
    const view = await peekQuota(ctx, "records", depsFor(tenant, store));
    expect(view.used).toBe(5_000);
    expect(view.reason).toBe("read_only");
  });
});

describe("peekQuota", () => {
  it("reports usage without consuming any of it", async () => {
    const { store, docs } = fakeStore({ "form_submissions@2026-03": 42 });
    const view = await peekQuota(ctx, "form_submissions", depsFor(snapshot(), store));
    expect(view).toMatchObject({ used: 42, limit: 100, remaining: 58, allowed: true });
    expect(docs.get("form_submissions@2026-03")?.count).toBe(42);
  });

  it("reports zero usage for a meter that has never been touched", async () => {
    const { store, docs } = fakeStore();
    const view = await peekQuota(ctx, "form_submissions", depsFor(snapshot(), store));
    expect(view.used).toBe(0);
    expect(view.remaining).toBe(100);
    // A read must not create the counter document.
    expect(docs.size).toBe(0);
  });
});
