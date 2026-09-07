/**
 * PUT /api/v1/forms/:formId/carousel — set the whole carousel at once.
 *
 * PUT rather than PATCH because the body is the complete new state: reorder,
 * alt-text edit and removal are all "the carousel is now exactly this". An
 * image dropped from the array has its object deleted, so this is not a
 * reversible operation.
 */
import { updateFormCarousel } from "@/server/services/form-media";
import { formIdParamSchema, updateCarouselSchema } from "@/server/services/forms";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseParams } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { formId: string };

export const PUT = route<Params>(async (request, { requestId, context, params }) => {
  const ctx = await context();
  const { formId } = parseParams(params, formIdParamSchema);
  const body = await parseBody(request, updateCarouselSchema);
  const carousel = await updateFormCarousel(ctx, formId, body);
  return jsonOk({ carousel }, requestId);
});
