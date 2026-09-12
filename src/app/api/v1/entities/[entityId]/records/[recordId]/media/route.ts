/**
 * POST /api/v1/entities/:entityId/records/:recordId/media — step one of a
 * record image upload.
 *
 * Returns a short-lived presigned PUT the browser uploads to directly; no
 * image bytes pass through this route (docs/BACKEND.md §4). Step two is
 * POST .../media/:mediaId, which is what points the field at the object.
 *
 * `fieldKey` travels in the body rather than the path: it names a field on
 * the tenant's own schema, and the same two-step shape as the form carousel
 * (`/forms/:formId/media`) keeps one upload flow in the client rather than
 * two that drift.
 *
 * Errors: 400 VALIDATION_FAILED (unknown field, field is not an `image`,
 * unsupported type, oversized declaration), 404 NOT_FOUND (wrong tenant or
 * wrong entity — repository scoping), 403 QUOTA_EXCEEDED on confirm.
 */
import { requestRecordImageUpload } from "@/server/services/record-media";
import { recordMediaFieldSchema, recordParamSchema } from "@/server/services/records";
import { requestUploadSchema } from "@/server/services/media";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseParams } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { entityId: string; recordId: string };

const bodySchema = requestUploadSchema.extend(recordMediaFieldSchema.shape);

export const POST = route<Params>(async (request, { requestId, context, params }) => {
  const ctx = await context();
  const { entityId, recordId } = parseParams(params, recordParamSchema);
  const { fieldKey, ...upload } = await parseBody(request, bodySchema);
  const ticket = await requestRecordImageUpload(ctx, entityId, recordId, fieldKey, upload);
  return jsonOk(ticket, requestId, undefined, { status: 201 });
});
