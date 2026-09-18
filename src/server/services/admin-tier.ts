/**
 * The manual tier override (GRAFT-27.4) — the one mutation on the v1 platform
 * admin surface, and a support escape hatch for when Stripe and Graft have
 * disagreed: a webhook that never landed, a refund, a comped account, a failed
 * trial conversion.
 *
 * ## 1. This file contains no tier-transition policy, and must not gain any
 *
 * `src/server/services/billing.ts` already encodes what docs/TIERS.md §4
 * describes: `applyDowngradePolicy()` freezes over-limit meters into
 * `tenants.readOnly` and unpublishes over-limit public forms (deleting
 * nothing); `applyUpgrade()` restores the tier's materialised limits and
 * clears the freeze and the grace window. A hand-written `tenants.tier` edit —
 * which is what a Mongo shell does today, and what this endpoint replaces —
 * skips all of that and leaves the tenant in a state no code path produces.
 *
 * So this module *routes*, and does not decide. It compares two positions on
 * the tier ladder, calls one of two existing functions, and writes an audit
 * row. If you ever find yourself adding a `readOnly.push(...)`, a form query or
 * a `TIER_LIMITS` lookup below, the change belongs in billing.ts behind an
 * amendment to this contract — not here.
 * `src/server/services/admin-tier.test.ts` asserts the delegation by reference,
 * so a local reimplementation fails the suite rather than passing it.
 *
 * ## 2. The audit row is written once, after the outcome is known
 *
 * `assertPlatformAdmin` (GRAFT-27.1) appends a row on every successful gate
 * pass, which is right for a read — it happened, and that is the whole story.
 * A write is different: AC7 requires *exactly one* row carrying `fromTier`,
 * `toTier`, `changed` and `reason`, none of which exist until the transition
 * has been attempted, and AC8 requires that row to say `ok: false` when it
 * failed. Two rows per call would be a worse log, not a fuller one.
 *
 * `deferredAdminAudit()` resolves that without touching the gate (which lives
 * under the protected `src/server/auth/**`): it is an `AdminAuditStore` that
 * *captures* the gate's entry instead of inserting it, and the service flushes
 * it — once, enriched with the outcome — when it knows what happened. A call
 * that never reaches a transition (a bad id, an invalid body, an unknown
 * tenant) never flushes, which is AC3's and AC9's "no audit entry" stated as a
 * mechanism rather than as a promise.
 *
 * ## 3. Tier gating is deliberately absent
 *
 * This endpoint *sets* tier state. It must never consult `can()`,
 * `checkQuota()` or `ctx.tier` to decide whether the admin may act — the
 * authority is the platform flag and nothing else. Nor is it ever scoped by
 * `ctx.tenantId`: the tenant in the path is the *subject* of the action, and a
 * tenant owner acting on their own workspace is refused exactly like anyone
 * else without the flag (AC6). There is no self-serve tier change; upgrades
 * remain Stripe checkout only.
 *
 * ## 4. Nothing here touches Stripe
 *
 * The override moves Graft's tier and creates, cancels and refunds nothing. A
 * tenant with a live subscription can be put on `free` here and Stripe will
 * keep billing them. That is accepted v1 behaviour, and the confirm dialog
 * (src/components/admin/tier-override-dialog.tsx) says so in words.
 */
import { z } from "zod";
import { AppError } from "@/server/http/envelope";
import { createLogger, type Logger } from "@/server/log";
import { TIERS, type Tier } from "@/server/tiers";
import {
  mongoAdminAuditStore,
  recordAdminAction,
  type AdminAuditDetails,
  type AdminAuditEntry,
  type AdminAuditStore,
} from "./admin-audit";
import {
  adminTenantParamsSchema,
  mongoAdminTenantStore,
  type AdminTenantStore,
} from "./admin-tenants";
import { applyDowngradePolicy, applyUpgrade, type BillingDeps } from "./billing";

/** The longest a reason may be. Long enough for a sentence of context, short
 * enough that the field stays a reason and not a pasted support thread. */
export const MAX_REASON_LENGTH = 500;

/**
 * AC4 — the enum is `TIERS`, the same constant `entitlements.ts` and
 * `billing.ts` read, so a tier added to the ladder is accepted here without an
 * edit and a tier removed from it is refused without one. A hand-written list
 * would be a second source of truth that drifts silently.
 *
 * AC3 — `.trim()` before `.min(1)` is what makes `"   "` a 400 rather than a
 * stored reason nobody can act on.
 */
export const adminTierOverrideSchema = z.object({
  tier: z.enum(TIERS),
  reason: z.string().trim().min(1).max(MAX_REASON_LENGTH),
});

export type AdminTierOverrideInput = z.infer<typeof adminTierOverrideSchema>;

export type AdminTierOverrideResult = Readonly<{
  id: string;
  fromTier: Tier;
  toTier: Tier;
  /** False when the tenant was already on the requested tier (AC5). */
  changed: boolean;
  /** The frozen meter keys as they stand after the call. */
  readOnly: string[];
}>;

/**
 * Where the tier sits on the ladder. Direction is all this module decides —
 * *what* each direction does is billing.ts's business.
 */
const LADDER: Record<Tier, number> = { free: 0, premium: 1, enterprise: 2 };

export type AdminTierDeps = {
  /** Reads the tenant document. The admin store, never the ctx-scoped repo. */
  tenants: Pick<AdminTenantStore, "findTenant">;
  /** Passed straight through to billing.ts; a test seam, never a policy knob. */
  billing: Partial<BillingDeps>;
  applyUpgrade: typeof applyUpgrade;
  applyDowngradePolicy: typeof applyDowngradePolicy;
};

/**
 * The defaults are the real functions, by reference. `admin-tier.test.ts`
 * asserts exactly that with `toBe`, which is the cheapest possible guard
 * against this file quietly growing its own copy of the freeze logic.
 */
export function resolveAdminTierDeps(overrides: Partial<AdminTierDeps> = {}): AdminTierDeps {
  return {
    tenants: overrides.tenants ?? mongoAdminTenantStore(),
    billing: overrides.billing ?? {},
    applyUpgrade: overrides.applyUpgrade ?? applyUpgrade,
    applyDowngradePolicy: overrides.applyDowngradePolicy ?? applyDowngradePolicy,
  };
}

/** What the service needs from a deferred audit sink in order to close it out. */
export type AdminTierAuditSink = {
  flush(details: AdminAuditDetails): Promise<void>;
};

export type DeferredAdminAudit = AdminTierAuditSink & {
  /** Handed to `assertPlatformAdmin` as its audit store. */
  sink: Pick<AdminAuditStore, "append">;
  /** The gate's entry, or null if the gate never passed. */
  captured(): AdminAuditEntry | null;
};

/**
 * An `AdminAuditStore` that holds the gate's row instead of inserting it, so
 * the action's outcome can be written onto the same row. See §2 above.
 *
 * `flush` is a no-op when the gate never appended — a refused caller writes no
 * audit row at all (GRAFT-27.1 AC7: the log records actions, not attempts) —
 * and refuses to write twice, so "exactly one row" holds even if a future
 * caller flushes on both a success and an error path.
 */
export function deferredAdminAudit(
  deps: { audit?: Pick<AdminAuditStore, "append"> } = {},
): DeferredAdminAudit {
  let entry: AdminAuditEntry | null = null;
  let flushed = false;

  return {
    sink: {
      async append(row) {
        entry = row;
      },
    },
    captured: () => entry,
    async flush(details) {
      if (!entry || flushed) return;
      flushed = true;
      await recordAdminAction(
        {
          actorUserId: entry.actorUserId,
          action: entry.action,
          targetTenantId: entry.targetTenantId,
          requestId: entry.requestId,
          details,
        },
        // The gate's timestamp, not a second one: the row describes one action,
        // and `at` is when the admin acted, not when the write completed.
        { audit: deps.audit ?? mongoAdminAuditStore(), now: () => entry!.at },
      );
    },
  };
}

const tierOf = (raw: unknown): Tier => (TIERS.includes(raw as Tier) ? (raw as Tier) : "free");

const readOnlyOf = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];

/**
 * Flip one tenant's tier through the existing transition policy, and record it.
 *
 * The caller has already passed `assertPlatformAdmin` — this function makes no
 * authorisation decision of its own and must never be called from a route that
 * has not gated first.
 */
export async function overrideTenantTier(
  input: { tenantId: unknown; body: unknown; audit: AdminTierAuditSink; log?: Logger },
  overrides: Partial<AdminTierDeps> = {},
): Promise<AdminTierOverrideResult> {
  const deps = resolveAdminTierDeps(overrides);
  const log = input.log ?? createLogger();

  // --- AC9: the id, before anything is written and before Mongo sees it.
  const params = adminTenantParamsSchema.safeParse({ tenantId: input.tenantId });
  if (!params.success) {
    throw new AppError("VALIDATION_FAILED", "Invalid request params", {
      source: "params",
      fields: { tenantId: "Expected a 24-character id" },
    });
  }
  const tenantId = params.data.tenantId;

  // --- AC3, AC4: the body. A refused override is not a half-applied one, and
  // it is not an action either, so nothing is flushed on this path.
  const parsed = adminTierOverrideSchema.safeParse(input.body ?? {});
  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", "Invalid request body", {
      source: "body",
      fields: Object.fromEntries(
        parsed.error.issues.map((issue) => [issue.path.join(".") || "(root)", issue.message]),
      ),
    });
  }
  const { tier: toTier, reason } = parsed.data;

  // --- AC9: a well-formed id for a tenant that does not exist. Still no row:
  // there is no tenant this could honestly be an audit of.
  const doc = await deps.tenants.findTenant(tenantId);
  if (!doc) throw new AppError("NOT_FOUND", "No such tenant");

  const fromTier = tierOf(doc.tier);

  // --- AC5: already there. Not a failure and not a no-response — an operator
  // confirming a tier should get a 200 — but emphatically not a re-run of the
  // downgrade policy, which would re-freeze an already-Free tenant that happens
  // to sit over Free's caps.
  if (fromTier === toTier) {
    await input.audit.flush({ fromTier, toTier, reason, changed: false, ok: true });
    // AC7 — the verb, the ids and the outcome. No tenant name, no email, no
    // reason text: the reason lives on the audit row, not in the log stream.
    log.info("admin.tenant.tier", { tenantId, fromTier, toTier, changed: false });
    return Object.freeze({
      id: tenantId,
      fromTier,
      toTier,
      changed: false,
      readOnly: readOnlyOf(doc.readOnly),
    });
  }

  // --- AC1, AC2: the transition itself, which is entirely billing.ts's.
  try {
    if (LADDER[toTier] > LADDER[fromTier]) {
      await deps.applyUpgrade(tenantId, toTier, deps.billing);
    } else {
      await deps.applyDowngradePolicy(tenantId, deps.billing, toTier);
    }
  } catch (error) {
    // --- AC8. The attempt is on the record with the reason that motivated it;
    // a half-applied transition nobody can find is the worst outcome available.
    // The flush is awaited before the throw so the row exists by the time the
    // 500 reaches the client, and its own failure is allowed to propagate: a
    // tier change we cannot audit is not a success either way.
    await input.audit.flush({ fromTier, toTier, reason, changed: false, ok: false });
    log.error("admin.tenant.tier", { tenantId, fromTier, toTier, ok: false, error });
    throw new AppError("INTERNAL", "Tier transition failed");
  }

  // Re-read rather than predict: `readOnly` is whatever applyDowngradePolicy
  // decided, and reporting a computed guess here would be exactly the
  // reimplementation this contract forbids.
  const after = await deps.tenants.findTenant(tenantId);
  const readOnly = readOnlyOf(after?.readOnly);

  try {
    await input.audit.flush({ fromTier, toTier, reason, changed: true, ok: true });
  } catch (error) {
    // The transition applied but could not be recorded. AC8's shape is the
    // right one here too: a 500 with the standard envelope and no
    // partial-success body. Reporting success for a tier change that left no
    // audit trail is the one outcome this contract most wants to avoid — the
    // operator re-checks the tenant and finds it moved, which is recoverable;
    // a silent unaudited flip is not.
    log.error("admin.tenant.tier.audit_failed", { tenantId, fromTier, toTier, error });
    throw new AppError("INTERNAL", "Tier transition could not be audited");
  }
  log.info("admin.tenant.tier", { tenantId, fromTier, toTier, changed: true });

  return Object.freeze({ id: tenantId, fromTier, toTier, changed: true, readOnly });
}
