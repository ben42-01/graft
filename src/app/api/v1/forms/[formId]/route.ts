/**
 * GET/PATCH/DELETE /api/v1/forms/:formId (GRAFT-08).
 *
 * Tenant isolation (AC6) needs no code here: the repository layer scopes every
 * read and write by `ctx.tenantId`, so another tenant's form is simply not
 * found — 404, not 403, so existence is not leaked.
 */
import {
  deleteForm,
  formIdParamSchema,
  getForm,
  updateForm,
  updateFormSchema,
} from "@/server/services/forms";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseParams } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { formId: string };

export const GET = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  const { formId } = parseParams(params, formIdParamSchema);
  const form = await getForm(ctx, formId);
  return jsonOk(form, requestId);
});

export const PATCH = route<Params>(async (request, { requestId, context, params }) => {
  const ctx = await context();
  const { formId } = parseParams(params, formIdParamSchema);
  const body = await parseBody(request, updateFormSchema);
  const form = await updateForm(ctx, formId, body);
  return jsonOk(form, requestId);
});

export const DELETE = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  const { formId } = parseParams(params, formIdParamSchema);
  await deleteForm(ctx, formId);
  return new Response(null, { status: 204, headers: { "x-request-id": requestId } });
});
