/**
 * GET /api/v1/admin/users — every user account across every tenant, for the
 * admin console's Users screen (src/server/services/admin-users.ts).
 *
 * Same shape as ../tenants/route.ts: gate first (404 for a non-admin, one
 * `admin.users.list` audit row per call), then Zod on the query, then the
 * service. `tenantId` is shape-checked before the gate only to name the audit
 * row's subject — it is validated after, so a non-admin can never tell a
 * well-formed query from a malformed one (see ../activities/route.ts).
 */
import { assertPlatformAdmin } from "@/server/auth/platform-admin";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseQuery } from "@/server/http/validate";
import { adminUserListQuerySchema, listAdminUsers } from "@/server/services/admin-users";

export const dynamic = "force-dynamic";

const objectIdHex = /^[0-9a-f]{24}$/i;

export const GET = route(async (request, { requestId, log, context }) => {
  const ctx = await context();
  const rawTenantId = new URL(request.url).searchParams.get("tenantId");
  await assertPlatformAdmin(ctx, {
    request,
    action: "admin.users.list",
    targetTenantId: rawTenantId && objectIdHex.test(rawTenantId) ? rawTenantId : null,
    log,
  });

  const query = parseQuery(request, adminUserListQuerySchema);
  const { items, meta } = await listAdminUsers(query);
  return jsonOk(items, requestId, meta);
});
