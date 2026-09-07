/**
 * GET /api/v1/public/media/:mediaId — the bytes behind a public form's
 * carousel image.
 *
 * A 307 to a short-lived presigned URL rather than a proxy: the bucket is
 * private in every environment (src/server/storage/s3.ts), and streaming
 * megabytes of image through a Node route handler would put every product
 * photo on the app's own request budget. The redirect keeps the bucket private
 * while letting the CDN and the browser cache the object itself.
 *
 * Authorization is the owning form's, not the image's — see
 * `findServablePublicMedia`. Unknown, detached, unpublished and killed are all
 * 404, matching the public form page's own collapse (GRAFT-10 AC1).
 */
import { AppError, jsonError } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { findServablePublicMedia } from "@/server/services/form-media";
import { presignedReadUrl } from "@/server/services/media";
import { READ_URL_TTL_SECONDS } from "@/server/storage/s3";

export const dynamic = "force-dynamic";

type Params = { mediaId: string };

export const GET = route<Params>(
  async (_request, { requestId, params }) => {
    const media = await findServablePublicMedia(params.mediaId);
    if (!media) return jsonError(new AppError("NOT_FOUND", "Image not found"), requestId);

    return new Response(null, {
      status: 307,
      headers: {
        location: await presignedReadUrl(media.key),
        "x-request-id": requestId,
        // Just under the signature's own lifetime, so a cached redirect can
        // never outlive the URL it points at.
        "cache-control": `public, max-age=${READ_URL_TTL_SECONDS - 60}`,
      },
    });
  },
  // The `public-form` scope keys on a form slug this route does not carry, so
  // it is stated explicitly rather than inherited from the /public/ row in
  // rate-limit/policy.ts: an image fetch is a cheap redirect and three of them
  // ride along with every page view.
  { rateLimit: { scopes: ["global-ip"] } },
);
