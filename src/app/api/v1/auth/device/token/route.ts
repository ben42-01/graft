/**
 * POST /api/v1/auth/device/token — the CLI polls until its request is approved.
 * PROTECTED PATH (.github/agent-policy.yml: src/app/api/v1/auth/**).
 *
 * `{ status: "pending" | "slow_down", interval }` while waiting. Once approved:
 * the session in the body — the refresh token too, because a CLI has no cookie
 * jar to receive it in. From then on the CLI refreshes through the ordinary
 * /auth/refresh by presenting it as the `graft_refresh` cookie. Denied is
 * FORBIDDEN; unknown, used or expired codes are all the same UNAUTHORIZED.
 */
import { pollDeviceAuthorization } from "@/server/services/device-auth";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseJsonBody } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const POST = route(async (request, { requestId, log }) => {
  const result = await pollDeviceAuthorization(await parseJsonBody(request), {}, requestId);
  if (result.status === "approved") log.info("auth.device.collected");
  return jsonOk(result, requestId, undefined, {
    // A session in a response body: never let anything between us and the
    // CLI keep a copy.
    headers: [["cache-control", "no-store"]],
  });
});
