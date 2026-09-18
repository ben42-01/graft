/**
 * POST /api/v1/workspace-templates/:templateId/preview — what applying the
 * template with these answers would create, what it costs against the
 * tenant's plan, which extras still fit, and any names that had to be
 * suffixed. Writes nothing.
 *
 * Errors: 404 NOT_FOUND (no such template), 400 VALIDATION_FAILED (an answer
 * the template does not have, or a payment/terms link that is not allowed).
 */
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseParams } from "@/server/http/validate";
import {
  previewBodySchema,
  previewWorkspaceTemplate,
  templateIdParamSchema,
} from "@/server/services/workspace-templates";

export const dynamic = "force-dynamic";

type Params = { templateId: string };

export const POST = route<Params>(async (request, { requestId, context, params }) => {
  const ctx = await context();
  const { templateId } = parseParams(params, templateIdParamSchema);
  const body = await parseBody(request, previewBodySchema);
  return jsonOk(await previewWorkspaceTemplate(ctx, templateId, body.answers), requestId);
});
