/**
 * POST /api/v1/public/forms/:publicSlug/submissions (GRAFT-09).
 *
 * `:publicSlug` is `forms.publicSlug`, itself `tenantSlug/formSlug` — two
 * plain dynamic segments, not a catch-all: Next.js does not allow a static
 * segment (`submissions`) after a catch-all, so `[tenantSlug]/[formSlug]` is
 * both the working shape and the correct one, since a `publicSlug` is always
 * exactly two parts.
 *
 * The only unauthenticated write surface in the product — `context()` is
 * never called here.
 *
 * Always 201, spam-scored or not (AC3) — errors: 400 VALIDATION_FAILED,
 * 403 QUOTA_EXCEEDED, 404 NOT_FOUND (unknown, unpublished or killed, all
 * indistinguishable — AC9), 429 RATE_LIMITED via the `public-form` scope
 * (docs/BACKEND.md §4, rate-limit/policy.ts).
 *
 * CORS (docs/BACKEND.md §4): "public form embed endpoints get a separate
 * permissive-but-scoped policy", distinct from the app-origin lock everything
 * else gets — a form is meant to be embedded on whatever third-party page
 * chose to publish it, so the origin side is wide open (`*`); "scoped" is
 * everything else: no credentials (this endpoint reads no cookie and issues
 * none), method and header allow-lists narrowed to exactly what a submit
 * needs. Applied via `route()`'s `headers` option, so every response —
 * 201, 400, 403, 404, 429 alike — carries it, not just the happy path.
 */
import { submitPublicForm } from "@/server/services/public-forms";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseJsonBody } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { tenantSlug: string; formSlug: string };

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "600",
};

export const POST = route<Params>(
  async (request, { requestId, params }) => {
    const body = await parseJsonBody(request);
    const result = await submitPublicForm(
      requestId,
      [params.tenantSlug, params.formSlug],
      body,
    );
    return jsonOk(result, requestId, undefined, { status: 201 });
  },
  { headers: CORS_HEADERS },
);

/**
 * A browser precedes a cross-origin POST with an unauthenticated preflight —
 * no body, no rate-limit scope worth spending on it, so it bypasses `route()`
 * entirely rather than being metered like a real submission attempt.
 */
export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
