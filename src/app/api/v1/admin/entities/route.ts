/**
 * GET /api/v1/admin/entities — entity definitions across every tenant, with
 * record counts, for the admin console's Entities screen
 * (src/server/services/admin-entities.ts). Schema metadata only; record data
 * is never read.
 *
 * Gate first, then validate — same ordering and reasoning as ../users/route.ts.
 */
import { assertPlatformAdmin } from "@/server/auth/platform-admin";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseQuery } from "@/server/http/validate";
import {
  adminEntityListQuerySchema,
  listAdminEntities,
} from "@/server/services/admin-entities";

export const dynamic = "force-dynamic";

const objectIdHex = /^[0-9a-f]{24}$/i;

export const GET = route(async (request, { requestId, log, context }) => {
  const ctx = await context();
  const rawTenantId = new URL(request.url).searchParams.get("tenantId");
  await assertPlatformAdmin(ctx, {
    request,
    action: "admin.entities.list",
    targetTenantId: rawTenantId && objectIdHex.test(rawTenantId) ? rawTenantId : null,
    log,
  });

  const query = parseQuery(request, adminEntityListQuerySchema);
  const { items, meta } = await listAdminEntities(query);
  return jsonOk(items, requestId, meta);
});
