/**
 * POST /api/v1/auth/refresh — rotate the session (GRAFT-03.1 AC2, AC3).
 * PROTECTED PATH (.github/agent-policy.yml: src/app/api/v1/auth/**).
 *
 * Thin by contract (docs/BACKEND.md §1): read the cookie, delegate, set the two
 * cookies the service produced. Every decision — is this token live, is this
 * reuse, whose family dies — belongs to the token service.
 *
 * Rate limiting for auth endpoints is GRAFT-04 and is deliberately absent here
 * rather than reinvented locally.
 */
import { accessCookie, refreshCookie } from "@/server/auth/cookies";
import { presentedRefreshToken } from "@/server/auth/session";
import { ACCESS_TTL_SECONDS, rotateSession } from "@/server/services/tokens";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";

export const dynamic = "force-dynamic";

export const POST = route(async (request, { requestId, log }) => {
  const session = await rotateSession(presentedRefreshToken(request));

  // tenantId/userId only — never the token, never the jti's neighbours (§1.5).
  log.info("auth.refresh.rotated", {
    tenantId: session.claims.tid,
    userId: session.claims.sub,
  });

  return jsonOk(
    { accessToken: session.accessToken, expiresAt: session.expiresAt },
    requestId,
    undefined,
    {
      headers: [
        ["set-cookie", refreshCookie(session.refreshToken, session.refreshMaxAge)],
        ["set-cookie", accessCookie(session.accessToken, ACCESS_TTL_SECONDS)],
      ],
    },
  );
});
