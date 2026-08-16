/**
 * POST /api/v1/auth/login — exchange credentials for a session (AC3, AC8).
 * PROTECTED PATH (.github/agent-policy.yml: src/app/api/v1/auth/**).
 *
 * The response body and both cookies are byte-for-byte the shape
 * /api/v1/auth/refresh returns, because a client should not care which of the
 * two minted the session it is holding.
 */
import { accessCookie, refreshCookie } from "@/server/auth/cookies";
import { login, loginSchema } from "@/server/services/accounts";
import { ACCESS_TTL_SECONDS } from "@/server/services/tokens";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const POST = route(async (request, { requestId, log }) => {
  const input = await parseBody(request, loginSchema);
  const session = await login(input);

  // Ids only. In particular not the email — a failed login logs nothing at all
  // beyond what route() writes, so the log is not an enumeration oracle either.
  log.info("auth.login.succeeded", {
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
