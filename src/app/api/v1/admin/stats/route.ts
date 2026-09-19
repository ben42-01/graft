/**
 * GET /api/v1/admin/stats — tenant counts for the `/admin` dashboard's stat
 * widgets. Read-only, same gate and audit posture as every other admin route
 * (src/server/auth/platform-admin.ts): `assertPlatformAdmin` first, refuses
 * with 404, writes `admin.stats.read` with no `targetTenantId` (the read is
 * about no single tenant).
 */
import { assertPlatformAdmin } from "@/server/auth/platform-admin";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { getAdminStats } from "@/server/services/admin-stats";

export const dynamic = "force-dynamic";

export const GET = route(async (request, { requestId, log, context }) => {
  const ctx = await context();
  await assertPlatformAdmin(ctx, {
    request,
    action: "admin.stats.read",
    log,
  });

  const stats = await getAdminStats();
  return jsonOk(stats, requestId);
});
