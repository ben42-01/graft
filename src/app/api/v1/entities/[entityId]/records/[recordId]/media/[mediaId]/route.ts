/**
 * POST   .../records/:recordId/media/:mediaId — step two: the bytes have
 *        landed, so verify them, charge `storage_mb` and point the field at
 *        the object.
 * DELETE .../records/:recordId/media/:mediaId — clear the field and delete
 *        the object.
 *
 * The confirm is safe to retry: a media id already in the field returns the
 * same view rather than charging twice. `fieldKey` is a query parameter on
 * the DELETE because a DELETE body is widely dropped in transit.
 */
import { attachRecordImage, removeRecordImage } from "@/server/services/record-media";
import { recordMediaFieldSchema, recordParamSchema } from "@/server/services/records";
import { mediaIdParamSchema } from "@/server/services/media";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseParams, parseQuery } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { entityId: string; recordId: string; mediaId: string };

const paramsSchema = recordParamSchema.extend(mediaIdParamSchema.shape);

export const POST = route<Params>(async (request, { requestId, context, params }) => {
  const ctx = await context();
  const { entityId, recordId, mediaId } = parseParams(params, paramsSchema);
  const { fieldKey } = await parseBody(request, recordMediaFieldSchema);
  const image = await attachRecordImage(ctx, entityId, recordId, fieldKey, mediaId);
  return jsonOk(image, requestId);
});

export const DELETE = route<Params>(async (request, { requestId, context, params }) => {
  const ctx = await context();
  const { entityId, recordId } = parseParams(params, paramsSchema);
  const { fieldKey } = parseQuery(request, recordMediaFieldSchema);
  await removeRecordImage(ctx, entityId, recordId, fieldKey);
  return jsonOk({ removed: true }, requestId);
});
