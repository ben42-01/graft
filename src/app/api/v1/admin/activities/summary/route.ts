/**
 * GET /api/v1/admin/activities/summary — aggregates for the Activity Monitor
 * (src/server/services/admin-activity-summary.ts): volume over time, failure
 * rate, and breakdowns by family, action, actor type and tenant.
 *
 * Takes the same query as ../route.ts (minus paging), with the same
 * gate-before-validate ordering and the same `targetTenantId` treatment.
 */
import { assertPlatformAdmin } from "@/server/auth/platform-admin";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseQuery } from "@/server/http/validate";
import { adminActivityListQuerySchema } from "@/server/services/admin-activities";
import { summarizeAdminActivities } from "@/server/services/admin-activity-summary";

export const dynamic = "force-dynamic";

const objectIdHex = /^[0-9a-f]{24}$/i;

export const GET = route(async (request, { requestId, log, context }) => {
  const ctx = await context();
  const rawTenantId = new URL(request.url).searchParams.get("tenantId");
  await assertPlatformAdmin(ctx, {
    request,
    action: "admin.activities.summary",
    targetTenantId: rawTenantId && objectIdHex.test(rawTenantId) ? rawTenantId : null,
    log,
  });

  const query = parseQuery(request, adminActivityListQuerySchema);
  return jsonOk(await summarizeAdminActivities(query), requestId);
});
