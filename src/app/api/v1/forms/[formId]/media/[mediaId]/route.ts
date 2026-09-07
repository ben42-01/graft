/**
 * POST   /api/v1/forms/:formId/media/:mediaId — step two: the bytes have
 *        landed, so verify them, charge `storage_mb` and append the slide.
 * DELETE /api/v1/forms/:formId/media/:mediaId — detach the slide and delete
 *        the object.
 *
 * The confirm is safe to retry: a media id already on the carousel returns the
 * carousel unchanged rather than adding a second copy or charging twice.
 */
import { z } from "zod";
import { attachFormImage, removeFormImage } from "@/server/services/form-media";
import { carouselItemSchema, formIdParamSchema } from "@/server/services/forms";
import { mediaIdParamSchema } from "@/server/services/media";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseParams } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { formId: string; mediaId: string };

const paramsSchema = formIdParamSchema.extend(mediaIdParamSchema.shape);

/** Alt text is the only thing the confirm carries; the bytes are already gone. */
const confirmSchema = z.object({ alt: carouselItemSchema.shape.alt });

export const POST = route<Params>(async (request, { requestId, context, params }) => {
  const ctx = await context();
  const { formId, mediaId } = parseParams(params, paramsSchema);
  const { alt } = await parseBody(request, confirmSchema);
  const carousel = await attachFormImage(ctx, formId, mediaId, alt);
  return jsonOk({ carousel }, requestId);
});

export const DELETE = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  const { formId, mediaId } = parseParams(params, paramsSchema);
  const carousel = await removeFormImage(ctx, formId, mediaId);
  return jsonOk({ carousel }, requestId);
});
