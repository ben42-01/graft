/**
 * Usage meters and quota enforcement (GRAFT-05, docs/TIERS.md §2.2, §4).
 *
 * PROTECTED PATH (.github/agent-policy.yml). Form usage is the monetisation
 * axis, so a counter that drifts is a billing bug, not a rounding error. Three
 * things make that hard to get wrong here:
 *
 *   - **The check *is* the increment.** `checkQuota` reserves in one guarded
 *     `$inc` — `{ count: { $lte: limit - amount } }` — so the decision and the
 *     write are the same round trip. A read-then-write would let 50 concurrent
 *     submissions all see "99 of 100" and all be admitted (AC3, AC4).
 *   - **The period is the tenant's billing anniversary**, not the calendar month
 *     (AC6). A tenant that signed up on the 20th gets a fresh allowance on the
 *     20th, and `billingPeriod` clamps an anchor day the month does not have.
 *   - **The 80% warning is claimed, not computed.** Crossing the threshold sets
 *     `warnedAt` on the counter document with a filter of `warnedAt: null`, so
 *     exactly one caller in a burst wins and the signal fires once per period
 *     (AC5). The document is per-period, so the claim resets with the counter.
 *
 * Counters are tenant-scoped business data, so every read and write goes through
 * the ctx-injecting repository layer (src/server/repositories/base.ts) — one
 * tenant can neither read nor increment another's meter, and that is enforced by
 * construction rather than by remembering to filter.
 */
import { MongoServerError, type ObjectId } from "mongodb";
import type { Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import { createLogger } from "@/server/log";
import { createRepository } from "@/server/repositories/base";
import { QUOTA_WARNING_RATIO, type TierLimits } from "@/server/tiers";
import { isReadOnly, limitFor, loadEntitlements, type Entitlements } from "./entitlements";

/**
 * The meter vocabulary. `resets` decides the period key: form submissions are
 * an allowance that refills each billing month, while records, seats and
 * entities are a standing population — counting those "per month" would reset a
 * tenant's record count every anniversary and let the plan be bypassed by
 * waiting.
 */
export const METERS = {
  form_submissions: { limit: "submissionsPerMonth", resets: "period" },
  active_forms: { limit: "activeForms", resets: "never" },
  internal_forms: { limit: "internalForms", resets: "never" },
  records: { limit: "records", resets: "never" },
  entities: { limit: "entities", resets: "never" },
  dashboards: { limit: "dashboards", resets: "never" },
  plugins: { limit: "plugins", resets: "never" },
  seats: { limit: "seats", resets: "never" },
  storage_mb: { limit: "storageMb", resets: "never" },
} as const satisfies Record<string, { limit: keyof TierLimits; resets: "period" | "never" }>;

export type Meter = keyof typeof METERS;

/** The period key for meters that never reset — one lifetime counter. */
export const LIFETIME_PERIOD = "all";

export type QuotaRefusal = "quota_exceeded" | "read_only";

export type QuotaResult = Readonly<{
  meter: Meter;
  period: string;
  allowed: boolean;
  /** `null` is unlimited — never compare it, branch on it (AC8). */
  limit: number | null;
  used: number;
  remaining: number | null;
  reason?: QuotaRefusal;
  /** True only on the call that crossed 80% for the first time this period. */
  warned: boolean;
}>;

export type QuotaWarning = {
  tenantId: string;
  meter: Meter;
  period: string;
  used: number;
  limit: number;
};

export type MeterDoc = { meter: string; period: string; count: number; warnedAt: Date | null };

/**
 * The counter port. Narrow on purpose: the only mutation the rest of the system
 * may perform on a meter is a guarded increment.
 */
export type MeterStore = {
  read(ctx: Ctx, meter: Meter, period: string): Promise<MeterDoc | null>;
  /** Create-if-absent. Losing the race is success — the document exists either way. */
  ensure(ctx: Ctx, meter: Meter, period: string): Promise<void>;
  /**
   * Atomic `$inc`, refused unless the pre-increment count is `<= maxCount`.
   * `null` maxCount means unlimited. Returns the document *after* the increment,
   * or null when the guard refused.
   */
  increment(
    ctx: Ctx,
    meter: Meter,
    period: string,
    amount: number,
    maxCount: number | null,
  ): Promise<MeterDoc | null>;
  /** Sets `warnedAt` iff it is still unset. True means this caller won the claim. */
  claimWarning(ctx: Ctx, meter: Meter, period: string, at: Date): Promise<boolean>;
};

export type MeterDeps = {
  store: MeterStore;
  now: () => Date;
  entitlements: (ctx: Ctx) => Promise<Entitlements>;
  emitWarning: (warning: QuotaWarning) => void;
};

type UsageMeterDoc = {
  tenantId: ObjectId;
  meter: string;
  period: string;
  count: number;
  warnedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const meters = createRepository<UsageMeterDoc>("usage_meters");

const isDuplicateKey = (error: unknown): boolean =>
  error instanceof MongoServerError && error.code === 11000;

const toMeterDoc = (doc: Pick<UsageMeterDoc, "meter" | "period" | "count" | "warnedAt">) => ({
  meter: doc.meter,
  period: doc.period,
  count: doc.count,
  warnedAt: doc.warnedAt ?? null,
});

export function mongoMeterStore(): MeterStore {
  return {
    async read(ctx, meter, period) {
      const doc = await meters.findOne(ctx, { meter, period });
      return doc ? toMeterDoc(doc) : null;
    },

    async ensure(ctx, meter, period) {
      if (await meters.findOne(ctx, { meter, period })) return;
      try {
        await meters.insertOne(ctx, {
          meter,
          period,
          count: 0,
          warnedAt: null,
          deletedAt: null,
        });
      } catch (error) {
        // The unique index on (tenantId, meter, period) decides; a lost race
        // means someone else created exactly the document we wanted.
        if (!isDuplicateKey(error)) throw error;
      }
    },

    async increment(ctx, meter, period, amount, maxCount) {
      // The guard lives in the filter, so the database evaluates it against the
      // same document version it increments. This is the whole of AC3.
      const filter =
        maxCount === null ? { meter, period } : { meter, period, count: { $lte: maxCount } };
      const doc = await meters.updateOne(ctx, filter, { $inc: { count: amount } });
      return doc ? toMeterDoc(doc) : null;
    },

    async claimWarning(ctx, meter, period, at) {
      const doc = await meters.updateOne(
        ctx,
        { meter, period, warnedAt: null },
        { $set: { warnedAt: at } },
      );
      return doc !== null;
    },
  };
}

/** The default signal sink. Emails and banners are their own issue; this is the
 * seam they replace, and it keeps the crossing visible in the meantime. */
const logQuotaWarning = (warning: QuotaWarning): void => {
  createLogger({ requestId: "quota.warning" }).warn("quota.threshold.crossed", {
    tenantId: warning.tenantId,
    meter: warning.meter,
    period: warning.period,
    used: warning.used,
    limit: warning.limit,
  });
};

function resolveDeps(overrides: Partial<MeterDeps> = {}): MeterDeps {
  return {
    store: overrides.store ?? mongoMeterStore(),
    now: overrides.now ?? (() => new Date()),
    entitlements: overrides.entitlements ?? ((ctx) => loadEntitlements(ctx)),
    emitWarning: overrides.emitWarning ?? logQuotaWarning,
  };
}

const daysInMonth = (year: number, monthIndex: number): number =>
  new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

const monthKey = (year: number, monthIndex: number): string =>
  `${year}-${String(monthIndex + 1).padStart(2, "0")}`;

/**
 * AC6 — the period a moment falls in, for a tenant whose plan renews on
 * `anchorDay`. The key names the month the period *opened* in, so consecutive
 * periods get consecutive keys whatever the anchor.
 *
 * A 31st anchor in a 30-day month renews on the last day of that month rather
 * than spilling into the next one, which would give that tenant an extra day of
 * allowance twice a year.
 */
export function billingPeriod(anchorDay: number, now: Date): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const renewal = Date.UTC(year, month, Math.min(anchorDay, daysInMonth(year, month)));
  if (now.getTime() >= renewal) return monthKey(year, month);
  return month === 0 ? monthKey(year - 1, 11) : monthKey(year, month - 1);
}

export function periodFor(meter: Meter, entitlements: Entitlements, now: Date): string {
  return METERS[meter].resets === "never"
    ? LIFETIME_PERIOD
    : billingPeriod(entitlements.billingAnchorDay, now);
}

const remainingFrom = (limit: number | null, used: number): number | null =>
  limit === null ? null : Math.max(0, limit - used);

/** The count at which the soft warning is due. Unlimited meters never warn. */
const warningAt = (limit: number | null): number | null =>
  limit === null || limit <= 0 ? null : Math.ceil(limit * QUOTA_WARNING_RATIO);

function assertAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new AppError("VALIDATION_FAILED", "A quota amount must be a positive whole number", {
      source: "body",
      fields: { amount: "Expected a positive whole number" },
    });
  }
}

const frozen = (
  meter: Meter,
  period: string,
  limit: number | null,
  used: number,
): QuotaResult => ({
  meter,
  period,
  allowed: false,
  limit,
  used,
  remaining: remainingFrom(limit, used),
  reason: "read_only",
  warned: false,
});

/**
 * A read-only view of a meter — what the UI renders and what a caller can check
 * before starting expensive work. It never creates or touches the counter, so it
 * is safe to call on a downgraded tenant's frozen resources (AC7).
 */
export async function peekQuota(
  ctx: Ctx,
  meter: Meter,
  overrides: Partial<MeterDeps> = {},
): Promise<QuotaResult> {
  const deps = resolveDeps(overrides);
  const entitlements = await deps.entitlements(ctx);
  const period = periodFor(meter, entitlements, deps.now());
  const limit = limitFor(entitlements, METERS[meter].limit);
  const used = (await deps.store.read(ctx, meter, period))?.count ?? 0;

  if (isReadOnly(entitlements, meter)) {
    return frozen(meter, period, limit, used);
  }
  const allowed = limit === null || used < limit;
  return {
    meter,
    period,
    allowed,
    limit,
    used,
    remaining: remainingFrom(limit, used),
    warned: false,
    ...(allowed ? {} : { reason: "quota_exceeded" as const }),
  };
}

/**
 * AC3, AC4, AC5, AC7, AC8. Reserves `amount` of the meter, atomically, and
 * reports what happened. A refusal has already left the counter untouched — the
 * guard is in the update filter, so there is nothing to roll back.
 */
export async function checkQuota(
  ctx: Ctx,
  meter: Meter,
  amount = 1,
  overrides: Partial<MeterDeps> = {},
): Promise<QuotaResult> {
  assertAmount(amount);
  const deps = resolveDeps(overrides);
  const entitlements = await deps.entitlements(ctx);
  const period = periodFor(meter, entitlements, deps.now());
  const limit = limitFor(entitlements, METERS[meter].limit);

  // A downgrade freeze outranks the counter: over-limit resources are readable,
  // never writable, and nothing about them is deleted (docs/TIERS.md §4).
  if (isReadOnly(entitlements, meter)) {
    const used = (await deps.store.read(ctx, meter, period))?.count ?? 0;
    return frozen(meter, period, limit, used);
  }

  await deps.store.ensure(ctx, meter, period);
  // `null` is unlimited (AC8): no ceiling is passed at all rather than a very
  // large one, so there is no number for a later edit to mistake for a cap.
  const maxCount = limit === null ? null : limit - amount;
  const incremented = await deps.store.increment(ctx, meter, period, amount, maxCount);

  if (!incremented) {
    const used = (await deps.store.read(ctx, meter, period))?.count ?? 0;
    return {
      meter,
      period,
      allowed: false,
      limit,
      used,
      remaining: remainingFrom(limit, used),
      reason: "quota_exceeded",
      warned: false,
    };
  }

  const used = incremented.count;
  const threshold = warningAt(limit);
  // Claimed rather than compared: a burst of callers can all be above the
  // threshold, and exactly one of them may own the signal (AC5).
  const warned =
    threshold !== null &&
    used >= threshold &&
    (await deps.store.claimWarning(ctx, meter, period, deps.now()));

  if (warned) {
    deps.emitWarning({ tenantId: ctx.tenantId, meter, period, used, limit: limit as number });
  }

  return {
    meter,
    period,
    allowed: true,
    limit,
    used,
    remaining: remainingFrom(limit, used),
    warned,
  };
}

/**
 * `checkQuota` for the common call site that has nothing useful to do with a
 * refusal: it raises the stable `QUOTA_EXCEEDED` the client switches on (AC4).
 */
export async function consumeQuota(
  ctx: Ctx,
  meter: Meter,
  amount = 1,
  overrides: Partial<MeterDeps> = {},
): Promise<QuotaResult> {
  const result = await checkQuota(ctx, meter, amount, overrides);
  if (result.allowed) return result;
  throw new AppError(
    "QUOTA_EXCEEDED",
    result.reason === "read_only"
      ? "This is read-only on your current plan. Upgrade to make changes; nothing has been deleted."
      : "You have reached your plan's limit. Upgrade to continue.",
    { meter, limit: result.limit, used: result.used, reason: result.reason },
  );
}
