/**
 * POST /api/v1/auth/device/decision — approve or deny a CLI sign-in request.
 * PROTECTED PATH (.github/agent-policy.yml: src/app/api/v1/auth/**).
 *
 * Approval binds the request to the caller's user and current tenant; the
 * session itself is only minted when the CLI next polls.
 */
import { decideDeviceAuthorization } from "@/server/services/device-auth";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseJsonBody } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const POST = route(async (request, { requestId, log, context }) => {
  const ctx = await context();
  const result = await decideDeviceAuthorization(ctx, await parseJsonBody(request));
  log.info(`auth.device.${result.status}`, { tenantId: ctx.tenantId, userId: ctx.userId });
  return jsonOk(result, requestId);
});
