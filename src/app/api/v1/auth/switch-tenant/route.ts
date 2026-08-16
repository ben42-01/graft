/**
 * POST /api/v1/auth/switch-tenant — mint a token for another workspace (AC6).
 * PROTECTED PATH (.github/agent-policy.yml: src/app/api/v1/auth/**).
 *
 * Authenticated: the caller proves who they are with the token they already
 * hold, and the service decides whether they may have one for the tenant they
 * asked for. The old token is *not* revoked — it stays valid for its remaining
 * minutes and keeps granting exactly the tenant it names, which is the property
 * bruno/security/forbidden-cross-tenant.bru pins down.
 */
import { accessCookie, refreshCookie } from "@/server/auth/cookies";
import { switchTenant, switchTenantSchema } from "@/server/services/accounts";
import { ACCESS_TTL_SECONDS } from "@/server/services/tokens";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const POST = route(async (request, { requestId, log, context }) => {
  const ctx = await context();
  const { tenantId } = await parseBody(request, switchTenantSchema);
  const session = await switchTenant(ctx, tenantId);

  log.info("auth.tenant.switched", {
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
