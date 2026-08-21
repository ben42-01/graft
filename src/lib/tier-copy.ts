/**
 * Display copy for the tier matrix — the human labels for `src/server/tiers.ts`'s
 * `TIER_LIMITS` / `TIER_FEATURES` keys, plus the one number formatter.
 *
 * Extracted from the landing page (`src/app/(public)/page.tsx`) in the
 * 2026-08-21 UI refinement, when the in-app Account page needed the same
 * copy: two hand-maintained copies of "what does `submissionsPerMonth` say
 * to a human" is exactly the drift the pricing page's data-driven approach
 * was written to avoid. Pure data + a pure function, no `"use client"`
 * needed — safe to import from a server or client component.
 */
import type { Feature, Tier, TierLimits } from "@/server/tiers";

export const TIER_LABEL: Record<Tier, string> = {
  free: "Free",
  premium: "Premium",
  enterprise: "Enterprise",
};

export const LIMIT_LABEL: Record<keyof TierLimits, string> = {
  seats: "Seats",
  activeForms: "Active forms",
  submissionsPerMonth: "Submissions / month",
  entities: "Custom entities",
  records: "Records",
  storageMb: "Storage",
  dashboards: "Dashboards",
  plugins: "Plugins enabled",
  internalForms: "Internal forms",
};

export const FEATURE_LABEL: Record<Feature, string> = {
  csv_import: "Batch CSV import",
  external_connectors: "External tenant connectors",
  inbound_webhooks: "Inbound webhooks",
  outbound_webhooks: "Outbound webhooks",
  public_api: "Public REST API",
  automations: "Automations",
  custom_roles: "Custom roles",
  audit_log: "Audit log",
  form_file_uploads: "Form file uploads",
  form_conditional_logic: "Conditional form logic",
  form_analytics: "Form analytics",
  remove_branding: "Remove Graft branding",
  custom_form_domain: "Custom form domain",
  invoicing: "Invoicing plugin",
  reports: "Reports plugin",
  sso: "SSO (SAML / OIDC)",
  white_label: "White-labeling",
  custom_plugins: "Custom plugin development",
};

/** `null` is unlimited — branched on, never compared (docs/TIERS.md AC8). */
export function formatLimit(key: string, value: number | null): string {
  if (value === null) return "Unlimited";
  if (key === "storageMb") return value >= 1024 ? `${value / 1024} GB` : `${value} MB`;
  return value.toLocaleString();
}
