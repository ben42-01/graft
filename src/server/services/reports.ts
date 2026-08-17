/**
 * Reports — the Chart widget's data source (GRAFT-13 AC3, AC5; docs/TIERS.md
 * §2.4 "Reports plugin" is Premium+).
 *
 * Not a protected path itself, but it exists only to *ask* entitlements
 * (`can`, ./entitlements.ts) and *read* meters (`peekQuota`, ./meters.ts) —
 * it never decides a tier and never writes a counter. This is what AC5 means
 * by "the lock is not client-only": the Chart widget's registry entry hides
 * it behind `GatedControl` in the UI, and this function refuses the same
 * question again, server-side, for a caller that skips the UI entirely.
 */
import type { Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import { can } from "./entitlements";
import { peekQuota, type Meter, type QuotaResult } from "./meters";

export type ReportsDeps = {
  can: (ctx: Ctx, feature: "reports") => Promise<boolean>;
  peekQuota: (ctx: Ctx, meter: Meter) => Promise<QuotaResult>;
};

function resolveDeps(overrides: Partial<ReportsDeps> = {}): ReportsDeps {
  return {
    can: overrides.can ?? can,
    peekQuota: overrides.peekQuota ?? peekQuota,
  };
}

/** AC5 — refuses on the server before touching the meter, whatever the client sent. */
export async function getMeterUsage(
  ctx: Ctx,
  meter: Meter,
  overrides: Partial<ReportsDeps> = {},
): Promise<QuotaResult> {
  const deps = resolveDeps(overrides);
  if (!(await deps.can(ctx, "reports"))) {
    throw new AppError(
      "FORBIDDEN",
      "Reports are a Premium feature. Upgrade to see this chart.",
      { feature: "reports" },
    );
  }
  return deps.peekQuota(ctx, meter);
}
