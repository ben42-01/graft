/**
 * GET /api/v1/admin/overview — the platform dashboard behind `/admin`
 * (src/server/services/admin-overview.ts). Counts and daily series only.
 *
 * Same gate and audit posture as every admin route
 * (src/server/auth/platform-admin.ts): `assertPlatformAdmin` first, refuses
 * with 404, writes one `admin.overview.read` row with no `targetTenantId`.
 * No tier gate, no `ctx.tenantId` scope, the inherited `^/api/v1/` rate limit
 * (see the note in ../tenants/route.ts before "fixing" that).
 */
import { assertPlatformAdmin } from "@/server/auth/platform-admin";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { getAdminOverview } from "@/server/services/admin-overview";

export const dynamic = "force-dynamic";

export const GET = route(async (request, { requestId, log, context }) => {
  const ctx = await context();
  await assertPlatformAdmin(ctx, { request, action: "admin.overview.read", log });
  return jsonOk(await getAdminOverview(), requestId);
});
