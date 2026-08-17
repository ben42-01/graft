/**
 * POST /api/v1/public/forms/:publicSlug/submissions (GRAFT-09).
 *
 * The only unauthenticated write surface in the product — `context()` is
 * never called here. `publicSlug` arrives as a catch-all segment array
 * (`forms.publicSlug` is itself `tenantSlug/formSlug`); `submitPublicForm`
 * reconstructs and validates it.
 *
 * Always 201, spam-scored or not (AC3) — errors: 400 VALIDATION_FAILED,
 * 403 QUOTA_EXCEEDED, 404 NOT_FOUND (unknown, unpublished or killed, all
 * indistinguishable — AC9), 429 RATE_LIMITED via the `public-form` scope
 * (docs/BACKEND.md §4, rate-limit/policy.ts).
 */
import { submitPublicForm } from "@/server/services/public-forms";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseJsonBody } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { publicSlug: string[] };

export const POST = route<Params>(async (request, { requestId, params }) => {
  const body = await parseJsonBody(request);
  const result = await submitPublicForm(requestId, params.publicSlug, body);
  return jsonOk(result, requestId, undefined, { status: 201 });
});
