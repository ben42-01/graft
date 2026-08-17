/**
 * POST /api/v1/forms/:formId/unpublish (GRAFT-08 AC3).
 *
 * Retains the form definition and every prior submission; nothing is deleted.
 */
import { formIdParamSchema, unpublishForm } from "@/server/services/forms";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseParams } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { formId: string };

export const POST = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  const { formId } = parseParams(params, formIdParamSchema);
  const form = await unpublishForm(ctx, formId);
  return jsonOk(form, requestId);
});
