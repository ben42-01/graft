/**
 * GET /api/v1/media/:mediaId — the bytes behind any image this tenant owns.
 *
 * The authenticated counterpart to `/api/v1/public/media/:mediaId`. That route
 * asks "is this image on a published, enabled form?"; this one asks only "is
 * this image this tenant's?", which is what an internal screen — a record
 * dialog, a Record List widget — needs, and it is the whole reason a record
 * image does not have to be public to be visible to the business that owns it.
 *
 * Authorization is the repository's: `getMedia` reads through the tenant-scoped
 * repository, so another tenant's id is simply not found. A `pending` row is a
 * 404 too — an upload whose bytes never landed has nothing to serve.
 *
 * A 307 to a short-lived presigned URL rather than a proxy, for the same
 * reason as the public route: the bucket is private in every environment and
 * streaming images through a Node handler would put every product photo on
 * the app's own request budget. `private` in the cache header because the
 * response is scoped to one tenant's session — a shared cache must never
 * hand this redirect to anyone else.
 */
import { AppError, jsonError } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { getMedia, mediaIdParamSchema, presignedReadUrl } from "@/server/services/media";
import { parseParams } from "@/server/http/validate";
import { READ_URL_TTL_SECONDS } from "@/server/storage/s3";

export const dynamic = "force-dynamic";

type Params = { mediaId: string };

export const GET = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  const { mediaId } = parseParams(params, mediaIdParamSchema);

  const media = await getMedia(ctx, mediaId);
  if (!media || media.status !== "ready" || media.deletedAt !== null) {
    return jsonError(new AppError("NOT_FOUND", "Image not found"), requestId);
  }

  return new Response(null, {
    status: 307,
    headers: {
      location: await presignedReadUrl(media.key),
      "x-request-id": requestId,
      // Just under the signature's own lifetime, so a cached redirect can
      // never outlive the URL it points at.
      "cache-control": `private, max-age=${READ_URL_TTL_SECONDS - 60}`,
    },
  });
});
