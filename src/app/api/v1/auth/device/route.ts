/**
 * POST /api/v1/auth/device — the CLI starts a browser sign-in.
 * PROTECTED PATH (.github/agent-policy.yml: src/app/api/v1/auth/**).
 *
 * Unauthenticated by nature: the CLI has no session yet. Returns the secret
 * deviceCode the CLI polls with and the short userCode the person types at
 * /device. All rules live in src/server/services/device-auth.ts.
 */
import { startDeviceAuthorization } from "@/server/services/device-auth";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseJsonBody } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const POST = route(async (request, { requestId, log }) => {
  const started = await startDeviceAuthorization(await parseJsonBody(request));
  // Neither code is logged: the deviceCode is a credential, and the userCode is
  // what a person reads off their screen to approve it.
  log.info("auth.device.started");
  return jsonOk(started, requestId, undefined, { status: 201 });
});
