"use client";

/**
 * The browser half of an image upload, in one place.
 *
 * It is three requests and the middle one does not touch this app:
 * `POST …/media` returns a presigned URL, the browser `PUT`s the file straight
 * to the bucket, and `POST …/media/:id` is what makes the image real
 * (docs/BACKEND.md §4 — bytes never pass through the API). A failure between
 * step two and three leaves an unattached object, which the server treats as
 * an abandoned upload, not as corruption.
 *
 * Extracted from `carousel-editor.tsx` when record images gained the same
 * flow: two hand-written copies of a three-step protocol is two places for
 * the `credentials: "omit"` on step two to be forgotten. That one is not a
 * detail — the bucket is a different origin and the signature is the only
 * authorisation it needs, so sending our cookies would be handing a session
 * to the storage provider.
 */

/** Mirrors `ALLOWED_IMAGE_TYPES` / `MAX_IMAGE_BYTES` in src/server/services/media.ts. */
export const ACCEPTED_IMAGE_TYPES = "image/jpeg,image/png,image/webp,image/avif";
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type UploadTarget = {
  /** Step one: where to ask for a presigned PUT. */
  ticketUrl: string;
  /** Extra fields the ticket request needs beyond the file's own type/size. */
  ticketBody?: Record<string, unknown>;
  /** Step three: where to confirm, given the id step one minted. */
  confirmUrl: (mediaId: string) => string;
  /** What the confirm carries — alt text for a carousel, a field key for a record. */
  confirmBody?: Record<string, unknown>;
};

export type UploadResult<T> = { ok: true; data: T } | { ok: false; message: string };

async function messageFrom(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return body?.error?.message ?? fallback;
}

export async function uploadImage<T>(
  file: File,
  target: UploadTarget,
): Promise<UploadResult<T>> {
  // Checked here as well as on the server so an oversized file costs one
  // refusal rather than a wasted round trip to the bucket.
  if (file.size > MAX_IMAGE_BYTES) {
    return { ok: false, message: "That image is larger than 5 MB. Try a smaller one." };
  }

  const ticketResponse = await fetch(target.ticketUrl, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...target.ticketBody,
      contentType: file.type,
      sizeBytes: file.size,
    }),
  });
  if (!ticketResponse.ok) {
    return {
      ok: false,
      message: await messageFrom(ticketResponse, "We couldn't start that upload."),
    };
  }
  const { data: ticket } = (await ticketResponse.json()) as {
    data: { mediaId: string; uploadUrl: string; contentType: string };
  };

  const put = await fetch(ticket.uploadUrl, {
    method: "PUT",
    // See the module docs: never our cookies, and the header must match the
    // signed ContentType exactly or the bucket rejects the object.
    credentials: "omit",
    headers: { "Content-Type": ticket.contentType },
    body: file,
  });
  if (!put.ok) {
    return {
      ok: false,
      message: "The upload didn't reach storage. Check your connection and try again.",
    };
  }

  const confirm = await fetch(target.confirmUrl(ticket.mediaId), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(target.confirmBody ?? {}),
  });
  if (!confirm.ok) {
    return {
      ok: false,
      message: await messageFrom(confirm, "The image uploaded but couldn't be attached."),
    };
  }

  const { data } = (await confirm.json()) as { data: T };
  return { ok: true, data };
}
