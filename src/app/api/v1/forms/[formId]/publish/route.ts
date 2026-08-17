/**
 * POST /api/v1/forms/:formId/publish (GRAFT-08 AC2, AC4).
 *
 * Errors: 404 NOT_FOUND (wrong tenant, or the form is internal-only —
 * see forms.ts), 409 CONFLICT (publicSlug collision), 403 QUOTA_EXCEEDED.
 */
import { formIdParamSchema, publishForm } from "@/server/services/forms";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseParams } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { formId: string };

export const POST = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  const { formId } = parseParams(params, formIdParamSchema);
  const form = await publishForm(ctx, formId);
  return jsonOk(form, requestId);
});
