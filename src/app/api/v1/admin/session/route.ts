/**
 * GET /api/v1/admin/session — the probe the admin console's gate calls
 * (GRAFT-27.1 AC1).
 *
 * The entire admin surface for this contract, and deliberately so: it exposes
 * no tenant data at all (cross-tenant reads are GRAFT-27.2), which makes the
 * whole diff the security boundary itself and nothing else.
 *
 * Thin by the rules in docs/BACKEND.md §1 — it authenticates, gates, and
 * returns. Note what it does *not* do:
 *
 *  - it never calls `createRepository`, and reads no tenant-scoped collection.
 *    `ctx` is used for identity, logging and rate-limit accounting only, and
 *    `ctx.tenantId` is never a filter here (AC10).
 *  - it does not consult `can()` / `checkQuota()` / `ctx.tier`. The platform
 *    admin surface is not a tenant feature and is not tier-gated
 *    (issue Constraints).
 *  - it declares no `rateLimit` of its own, so the `^/api/v1/` row in
 *    src/server/rate-limit/policy.ts applies — `global-ip`, `api`, `user`,
 *    exactly as for every other authenticated route (AC9).
 *
 * A non-admin caller gets 404, not 403, and an anonymous one gets 401 from the
 * session path before the gate runs at all (AC4). Both reasons are written up
 * in src/server/auth/platform-admin.ts.
 */
import { assertPlatformAdmin } from "@/server/auth/platform-admin";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";

export const dynamic = "force-dynamic";

export const GET = route(async (request, { requestId, log, context }) => {
  const ctx = await context();
  const actor = await assertPlatformAdmin(ctx, {
    request,
    action: "admin.session.read",
    log,
  });
  return jsonOk(actor, requestId);
});
