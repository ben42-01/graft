/**
 * GET /api/v1/admin/audit — the platform-admin audit log, for the admin
 * console's Audit screen (src/server/services/admin-audit-read.ts).
 *
 * Reading the audit log is itself an admin action and is audited like any
 * other (`admin.audit.read`) — the log records who looked at the log.
 * Gate first, then validate — same ordering as ../users/route.ts.
 */
import { assertPlatformAdmin } from "@/server/auth/platform-admin";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseQuery } from "@/server/http/validate";
import { adminAuditListQuerySchema, listAdminAudit } from "@/server/services/admin-audit-read";

export const dynamic = "force-dynamic";

const objectIdHex = /^[0-9a-f]{24}$/i;

export const GET = route(async (request, { requestId, log, context }) => {
  const ctx = await context();
  const rawTenantId = new URL(request.url).searchParams.get("tenantId");
  await assertPlatformAdmin(ctx, {
    request,
    action: "admin.audit.read",
    targetTenantId: rawTenantId && objectIdHex.test(rawTenantId) ? rawTenantId : null,
    log,
  });

  const query = parseQuery(request, adminAuditListQuerySchema);
  const { items, meta } = await listAdminAudit(query);
  return jsonOk(items, requestId, meta);
});
