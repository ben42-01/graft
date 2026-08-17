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

export const LIMIT_KEYS = Object.keys(TIER_LIMITS.free) as (keyof TierLimits)[];

/**
 * The entitlement vocabulary (docs/TIERS.md §2.2–§2.5) — capability gates, as
 * opposed to the counted limits above.
 *
 * These keys are the words every later feature will use at its call site, so
 * they name the *capability* rather than the screen that exposes it: a key is
 * renamed only by a migration, and a wrong name propagates. Anything already
 * available on every tier (manual CRUD, CSV export) is deliberately absent —
 * a gate nobody is behind is a gate nobody maintains.
 */
export const FEATURES = [
  "csv_import",
  "external_connectors",
  "inbound_webhooks",
  "outbound_webhooks",
  "public_api",
  "automations",
  "custom_roles",
  "audit_log",
  "form_file_uploads",
  "form_conditional_logic",
  "form_analytics",
  "remove_branding",
  "custom_form_domain",
  "invoicing",
  "reports",
  "sso",
  "white_label",
  "custom_plugins",
] as const;

export type Feature = (typeof FEATURES)[number];
export type TierFeatures = Record<Feature, boolean>;

const featureSet = (granted: readonly Feature[]): TierFeatures =>
  Object.fromEntries(FEATURES.map((f) => [f, granted.includes(f)])) as TierFeatures;

/** Premium gets everything except what §2.5 reserves for Enterprise. */
const ENTERPRISE_ONLY: readonly Feature[] = [
  "custom_form_domain",
  "sso",
  "white_label",
  "custom_plugins",
];

export const TIER_FEATURES: Record<Tier, TierFeatures> = {
  free: featureSet([]),
  premium: featureSet(FEATURES.filter((f) => !ENTERPRISE_ONLY.includes(f))),
  enterprise: featureSet(FEATURES),
};

/** Soft warning threshold — email + in-app banner (docs/TIERS.md §2.2). */
export const QUOTA_WARNING_RATIO = 0.8;
