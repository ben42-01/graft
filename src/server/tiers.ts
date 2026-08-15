/**
 * The tier limit matrix (docs/TIERS.md §2.1, §2.2) as pure data.
 *
 * This is the shape that gets materialised onto `tenants.limits` at signup so
 * Enterprise deals can override per-tenant without a code change. Enforcement
 * (can / checkQuota) is a service concern and lives elsewhere.
 */

export const TIERS = ["free", "premium", "enterprise"] as const;
export type Tier = (typeof TIERS)[number];

/** null means unlimited (fair use). */
export type TierLimits = {
  seats: number | null;
  plugins: number | null;
  entities: number | null;
  records: number | null;
  storageMb: number | null;
  dashboards: number | null;
  activeForms: number | null;
  submissionsPerMonth: number | null;
  internalForms: number | null;
};

export const TIER_LIMITS: Record<Tier, TierLimits> = {
  free: {
    seats: 1,
    plugins: 3,
    entities: 3,
    records: 2_000,
    storageMb: 250,
    dashboards: 1,
    activeForms: 2,
    submissionsPerMonth: 100,
    internalForms: 3,
  },
  premium: {
    seats: 15,
    plugins: null,
    entities: 25,
    records: 100_000,
    storageMb: 20_480,
    dashboards: 10,
    activeForms: 20,
    submissionsPerMonth: 5_000,
    internalForms: null,
  },
  enterprise: {
    seats: null,
    plugins: null,
    entities: null,
    records: null,
    storageMb: 1_048_576,
    dashboards: null,
    activeForms: null,
    submissionsPerMonth: null,
    internalForms: null,
  },
};

/** Soft warning threshold — email + in-app banner (docs/TIERS.md §2.2). */
export const QUOTA_WARNING_RATIO = 0.8;
