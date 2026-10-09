/**
 * POST /api/v1/auth/device/lookup — the approval page reads a pending request.
 * PROTECTED PATH (.github/agent-policy.yml: src/app/api/v1/auth/**).
 *
 * Needs a session: only a signed-in person can see which machine is asking.
 * A POST, not a GET with the code in the URL, so the code stays out of access
 * logs and browser history.
 */
import { lookupDeviceAuthorization } from "@/server/services/device-auth";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseJsonBody } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const POST = route(async (request, { requestId, context }) => {
  const ctx = await context();
  return jsonOk(await lookupDeviceAuthorization(ctx, await parseJsonBody(request)), requestId);
});
