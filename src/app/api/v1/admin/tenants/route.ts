/**
 * GET /api/v1/admin/tenants — every tenant in the database (GRAFT-27.2 AC1–AC4).
 *
 * Thin by the rules in docs/BACKEND.md §1: it authenticates, gates, validates,
 * delegates, and returns. The interesting parts are what it does *not* do:
 *
 *  - it never calls `createRepository` and never filters by `ctx.tenantId`.
 *    This list deliberately spans tenants, and the caller's own workspace is in
 *    no way privileged in the results (AC10). `ctx` is used for identity,
 *    logging and rate-limit accounting only.
 *  - it does not consult `can()` / `checkQuota()` / `ctx.tier`. The platform
 *    admin surface is not a tenant feature and is not tier-gated (Constraints).
 *  - it declares no `rateLimit` of its own, so the `^/api/v1/` row in
 *    src/server/rate-limit/policy.ts applies: `global-ip`, `api`, `user`.
 *
 *    Note that the `api` and `user` buckets are keyed on the admin's *own*
 *    tenant and user. That is intentional and is not a bug to "fix": the
 *    alternative — exempting the admin surface because it is not about one
 *    tenant — would turn it into the one unlimited endpoint in the product.
 *    An admin spending their own tenant's budget is the correct trade.
 *
 * `assertPlatformAdmin` is the first statement after `context()`, refuses with
 * 404 rather than 403, and writes the `admin.tenants.list` audit row (AC9).
 * Nothing below it runs for a caller without the flag, so a non-admin receives
 * no tenant data of any kind — including their own (AC7).
 */
import { assertPlatformAdmin } from "@/server/auth/platform-admin";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseQuery } from "@/server/http/validate";
import { adminTenantListQuerySchema, listAdminTenants } from "@/server/services/admin-tenants";

export const dynamic = "force-dynamic";

export const GET = route(async (request, { requestId, log, context }) => {
  const ctx = await context();
  await assertPlatformAdmin(ctx, {
    request,
    // AC9 — one row per call. `targetTenantId` stays null: a list is about no
    // single tenant, and recording one would be a lie about what was read.
    action: "admin.tenants.list",
    log,
  });

  // Zod at the boundary: an unknown tier or a malformed cursor is a 400 naming
  // the field (AC4), never an empty list and never a driver error.
  const query = parseQuery(request, adminTenantListQuerySchema);
  const { items, meta } = await listAdminTenants(query);

  return jsonOk(items, requestId, meta);
});
