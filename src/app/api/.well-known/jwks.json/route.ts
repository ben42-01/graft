/**
 * GET /api/.well-known/jwks.json (GRAFT-03.1 AC1, AC8).
 * PROTECTED PATH (.github/agent-policy.yml: src/app/api/.well-known/**).
 *
 * The one endpoint that deliberately does not use the Graft envelope: JWKS is
 * RFC 7517's `{ "keys": [...] }` and is consumed by standard libraries that
 * expect exactly that document. Wrapping it in `{ data }` would make it a Graft
 * format wearing a standard name (the issue's API Contract says the same).
 *
 * Public keys only — see src/server/auth/keys.ts, where the JWK is built field
 * by field so no private component can be carried along by accident.
 */
import { keyring } from "@/server/auth/keys";
import { route } from "@/server/http/handler";

export const dynamic = "force-dynamic";

/**
 * Five minutes. Long enough that verifiers are not polling us on every request,
 * short enough that a rotation propagates well inside an access token's 15-minute
 * life — which is what makes AC8's overlap window sufficient.
 */
const MAX_AGE_SECONDS = 300;

export const GET = route((_request, { requestId }) => {
  return new Response(JSON.stringify({ keys: keyring().jwks }), {
    status: 200,
    headers: {
      // application/json rather than application/jwk-set+json: every JWKS client
      // and every HTTP tool parses the former, and the media type carries no
      // information the `keys` array does not.
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${MAX_AGE_SECONDS}`,
      "x-request-id": requestId,
    },
  });
});
