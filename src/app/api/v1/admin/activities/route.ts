/**
 * GET /api/v1/admin/activities — the read/search surface for the tenant
 * activity log (GRAFT-29.2), on top of the collection GRAFT-29.1 writes.
 *
 * Thin by the rules in docs/BACKEND.md §1, and the same shape as
 * ../tenants/route.ts in every particular that applies: no `createRepository`,
 * no `ctx.tenantId` filter, no tier gate, and the inherited `^/api/v1/`
 * rate-limit row (see the note in tenants/route.ts before "fixing" that).
 *
 * ## Why `tenantId` is shape-checked before the gate, and validated after
 *
 * Same reasoning as tenants/[tenantId]/route.ts: the platform-admin gate must
 * run before any 400 can be produced, or a non-admin could distinguish "this
 * query is well-formed" from "it isn't" without ever holding the flag — the
 * exact oracle the 404-not-403 decision exists to close. So `tenantId` is
 * pulled off the raw URL and shape-checked only (never rejected) to become the
 * audit row's `targetTenantId` (AC8), and the *rest* of the query — including
 * a malformed `tenantId` — is validated by `adminActivityListQuerySchema` only
 * once `assertPlatformAdmin` has already passed.
 */
import { assertPlatformAdmin } from "@/server/auth/platform-admin";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseQuery } from "@/server/http/validate";
import {
  adminActivityListQuerySchema,
  listAdminActivities,
} from "@/server/services/admin-activities";

export const dynamic = "force-dynamic";

const objectIdHex = /^[0-9a-f]{24}$/i;

export const GET = route(async (request, { requestId, log, context }) => {
  const ctx = await context();

  const rawTenantId = new URL(request.url).searchParams.get("tenantId");
  const targetTenantId = rawTenantId && objectIdHex.test(rawTenantId) ? rawTenantId : null;

  await assertPlatformAdmin(ctx, {
    request,
    // AC8 — one row per call, `targetTenantId` set to the `tenantId` filter or
    // null when the read is not scoped to one tenant.
    action: "admin.activities.read",
    targetTenantId,
    log,
  });

  // Zod at the boundary: a malformed tenantId/action/date range is a 400
  // naming the field (AC2/AC3/AC5), never an empty list and never a driver error.
  const query = parseQuery(request, adminActivityListQuerySchema);
  const { items, meta } = await listAdminActivities(query);

  return jsonOk(items, requestId, meta);
});
