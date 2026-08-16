/**
 * POST /api/v1/auth/signup — account + tenant bootstrap (GRAFT-03.2 AC1–AC5).
 * PROTECTED PATH (.github/agent-policy.yml: src/app/api/v1/auth/**).
 *
 * Thin by contract (docs/BACKEND.md §1): validate, delegate, envelope. Signup
 * deliberately does *not* return a session — the account is unverified until the
 * emailed token is spent (AC3), and handing back a token here would make the
 * verification step optional in practice.
 *
 * Rate limiting for auth endpoints is GRAFT-04 and is deliberately absent here
 * rather than reinvented locally.
 */
import { signup, signupSchema } from "@/server/services/accounts";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const POST = route(async (request, { requestId, log }) => {
  const input = await parseBody(request, signupSchema);
  const { userId, tenantId } = await signup(input);

  // Ids only — never the email, never the password (§1.5).
  log.info("auth.signup.created", { tenantId, userId });

  return jsonOk({ userId, tenantId }, requestId, undefined, { status: 201 });
});
