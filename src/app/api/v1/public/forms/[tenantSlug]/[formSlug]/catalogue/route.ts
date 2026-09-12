/**
 * GET /api/v1/public/forms/:tenantSlug/:formSlug/catalogue — one page of the
 * records a published form invites visitors to browse.
 *
 * The product's *second* unauthenticated surface, and its first
 * unauthenticated read of tenant data. `context()` is never called here; the
 * tenant is discovered from the form's own `publicSlug`, never accepted from
 * the request.
 *
 * Everything that makes that safe lives in `getPublicCatalogue`: the field
 * allowlist, the server-side page cap, the soft-delete exclusion, and the
 * collapse of unknown/unpublished/killed/not-a-catalogue into one 404 so a
 * scraper cannot tell them apart. This route only passes through the two slug
 * segments and the paging knobs.
 *
 * Rate limiting is the `public-form` scope, inherited from the `/api/v1/public/`
 * row in rate-limit/policy.ts — deliberately the same budget the submit
 * endpoint spends from, because paging a catalogue and posting to it are the
 * same visitor.
 *
 * CORS matches the submit route: a form is meant to be embedded on whatever
 * page published it, so the origin side is open and everything else is
 * narrowed — GET only, no credentials, since this endpoint reads no cookie.
 */
import { getPublicCatalogue } from "@/server/services/public-catalogue";
import { AppError, jsonError, jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";

export const dynamic = "force-dynamic";

type Params = { tenantSlug: string; formSlug: string };

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "600",
};

export const GET = route<Params>(
  async (request, { requestId, params }) => {
    const url = new URL(request.url);
    const page = await getPublicCatalogue(params.tenantSlug, params.formSlug, {
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    if (!page) return jsonError(new AppError("NOT_FOUND", "Form not found"), requestId);
    return jsonOk(page.items, requestId, page.meta);
  },
  { headers: CORS_HEADERS },
);

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
