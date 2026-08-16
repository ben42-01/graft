/**
 * POST /api/v1/auth/logout — 204, and the session is over (GRAFT-03.1 AC6).
 * PROTECTED PATH (.github/agent-policy.yml).
 *
 * 204 rather than the standard envelope: there is no resource to describe, and
 * inventing `{ data: null }` would be a body whose only purpose is to have a
 * shape. Errors still use the envelope — a failed logout has something to say.
 */
import { clearedCookies } from "@/server/auth/cookies";
import { authenticate, presentedRefreshToken } from "@/server/auth/session";
import { endSession } from "@/server/services/tokens";
import { route } from "@/server/http/handler";

export const dynamic = "force-dynamic";

export const POST = route(async (request, { requestId, log }) => {
  const claims = await authenticate(request, { requestId });
  await endSession({ claims, presentedRefresh: presentedRefreshToken(request) });

  log.info("auth.logout", { tenantId: claims.tid, userId: claims.sub });

  const headers = new Headers({ "x-request-id": requestId });
  for (const cookie of clearedCookies()) headers.append("set-cookie", cookie);
  return new Response(null, { status: 204, headers });
});
