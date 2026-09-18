/**
 * POST /api/v1/admin/tenants/:tenantId/tier — the manual tier override
 * (GRAFT-27.4). The one mutation on the v1 platform-admin surface.
 *
 * Thin, like every route (docs/BACKEND.md §1): it gates, it parses the id
 * shape, it delegates. Every decision about *what a tier change means* lives in
 * src/server/services/admin-tier.ts, and every decision about what a tier
 * *transition* does lives in src/server/services/billing.ts. Nothing here
 * writes to a collection.
 *
 * ## Why the gate runs before the 400, again
 *
 * Same ordering as the sibling GET (../route.ts), for the same reason: the id
 * is shape-checked first but only *rejected* after `assertPlatformAdmin` has
 * passed, so a non-admin gets an identical 404 for every id and every body —
 * valid, malformed or missing — and never learns from a 400 that this path
 * exists and parses its input. Only a platform admin ever sees a
 * VALIDATION_FAILED here (AC6 vs AC3/AC4/AC9).
 *
 * That is also why the *body* is not touched until the service has it: parsing
 * it in the route would move a validation decision in front of the gate.
 *
 * ## Why the audit store is deferred
 *
 * `assertPlatformAdmin` appends an audit row on every successful gate pass.
 * AC7 wants exactly one row, carrying `fromTier`, `toTier`, `changed` and
 * `reason` — none of which are known until the transition has been attempted —
 * and AC8 wants that same row to say `ok: false` when it failed. So the gate is
 * handed `deferredAdminAudit()`'s sink, which captures its row instead of
 * inserting it, and the service flushes it once, enriched, when the outcome is
 * known. A refused caller, a bad id, an invalid body or an unknown tenant never
 * reaches a flush and so writes no row at all.
 *
 * No tier gate: this endpoint *sets* tier state and must never consult `can()`,
 * `checkQuota()` or `ctx.tier` to decide whether the admin may act. No
 * `ctx.tenantId` scoping either — `:tenantId` is the subject of the action, not
 * a scope the caller proved a right to. Rate limiting is the inherited
 * `^/api/v1/` row (docs/BACKEND.md §4), keyed on the admin's own tenant and
 * user; see the note in ../../route.ts before "fixing" that.
 */
import { assertPlatformAdmin } from "@/server/auth/platform-admin";
import { AppError, jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { deferredAdminAudit, overrideTenantTier } from "@/server/services/admin-tier";
import { adminTenantParamsSchema } from "@/server/services/admin-tenants";

export const dynamic = "force-dynamic";

type Params = { tenantId: string };

export const POST = route<Params>(async (request, { requestId, log, params, context }) => {
  const ctx = await context();

  const parsed = adminTenantParamsSchema.safeParse(params);
  const targetTenantId = parsed.success ? parsed.data.tenantId : null;

  const audit = deferredAdminAudit();

  await assertPlatformAdmin(ctx, {
    request,
    action: "admin.tenant.tier",
    targetTenantId,
    log,
    deps: { audit: audit.sink },
  });

  if (!parsed.success) {
    // A malformed id: audited with nothing, because there is no tenant this
    // could honestly name and no transition was attempted (AC9).
    throw new AppError("VALIDATION_FAILED", "Invalid request params", {
      source: "params",
      fields: { tenantId: "Expected a 24-character id" },
    });
  }

  // `request.json()` can throw on a malformed body; the service's Zod boundary
  // turns `undefined` into the same VALIDATION_FAILED an empty object gets, so
  // a broken body and an empty one are one case rather than a 500 and a 400.
  const body = await request.json().catch(() => undefined);

  const result = await overrideTenantTier(
    { tenantId: parsed.data.tenantId, body, audit, log },
    {},
  );

  return jsonOk(result, requestId);
});
