/**
 * POST /api/v1/auth/verify-email — spend the verification token (AC3).
 * PROTECTED PATH (.github/agent-policy.yml: src/app/api/v1/auth/**).
 *
 * 204 rather than an envelope: there is nothing to say, and returning who was
 * verified would make this endpoint an oracle for whether a token maps to a
 * known account.
 */
import { verifyEmail, verifyEmailSchema } from "@/server/services/accounts";
import { route } from "@/server/http/handler";
import { parseBody } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const POST = route(async (request, { log }) => {
  const { token } = await parseBody(request, verifyEmailSchema);
  await verifyEmail(token);

  // No token, no email, no user id — the value is a live credential until spent.
  log.info("auth.verification.accepted", {});

  // `route()` stamps x-request-id on the way out, so the id is still traceable.
  return new Response(null, { status: 204 });
});
