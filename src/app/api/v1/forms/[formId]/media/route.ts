/**
 * POST /api/v1/forms/:formId/media — step one of a carousel image upload.
 *
 * Returns a short-lived presigned PUT the browser uploads to directly; no
 * image bytes ever pass through this route (docs/BACKEND.md §4). Step two is
 * POST /api/v1/forms/:formId/media/:mediaId, which is what actually attaches
 * the slide.
 *
 * Errors: 400 VALIDATION_FAILED (unsupported type, oversized declaration),
 * 404 NOT_FOUND (wrong tenant — repository scoping), 409 CONFLICT (carousel
 * already full), 403 QUOTA_EXCEEDED is raised on confirm, not here.
 */
import { requestFormImageUpload } from "@/server/services/form-media";
import { formIdParamSchema } from "@/server/services/forms";
import { requestUploadSchema } from "@/server/services/media";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseParams } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { formId: string };

export const POST = route<Params>(async (request, { requestId, context, params }) => {
  const ctx = await context();
  const { formId } = parseParams(params, formIdParamSchema);
  const body = await parseBody(request, requestUploadSchema);
  const ticket = await requestFormImageUpload(ctx, formId, body);
  return jsonOk(ticket, requestId, undefined, { status: 201 });
});
