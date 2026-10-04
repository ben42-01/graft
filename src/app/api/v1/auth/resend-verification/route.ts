/**
 * POST /api/v1/auth/resend-verification — a fresh verification link for an
 * account that has not confirmed its email yet.
 * PROTECTED PATH (.github/agent-policy.yml: src/app/api/v1/auth/**).
 *
 * Always 204, whatever the address: see `resendVerification` for why the
 * answer cannot depend on whether the account exists.
 */
import { resendVerification, resendVerificationSchema } from "@/server/services/accounts";
import { route } from "@/server/http/handler";
import { parseBody } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const POST = route(async (request, { log }) => {
  const body = await parseBody(request, resendVerificationSchema);
  await resendVerification(body);

  // No email — the address is the one thing this line must not carry.
  log.info("auth.verification.resend_requested", {});
  return new Response(null, { status: 204 });
});
