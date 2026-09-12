"use client";

/**
 * One `image` field on one record — the picture of the thing the record is.
 *
 * Two things shape this control:
 *
 *   - **An image needs a record to belong to.** Media is owned by the record
 *     (`ownerType: "record"`), which is what lets the public catalogue decide
 *     whether a photo may be served by asking whether *that record* is on
 *     display. So there is nothing to upload to until the record exists, and
 *     on a new record this says so rather than offering a control that would
 *     404. It is a real constraint of the model, not an oversight, so it is
 *     stated plainly instead of hidden behind a disabled button.
 *   - **The value is written out-of-band, not with the rest of the form.**
 *     Uploading *is* the save: the confirm points the field at the object in
 *     the same request that charges storage for it. So this control does not
 *     participate in the dialog's payload at all (`toRecordPayload` skips
 *     image fields), and replacing a photo takes effect whether or not the
 *     dialog is subsequently saved.
 *
 * The preview reads `/api/v1/media/:id` — the authenticated byte route — so a
 * record's photo is visible to the business that owns it without having to be
 * public first.
 */
import { useRef, useState } from "react";
import { ImagePlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ACCEPTED_IMAGE_TYPES, uploadImage } from "@/lib/media/upload";

/** The authenticated read path — distinct from `/api/v1/public/media/:id`,
 * which only serves what a published form is currently showing. */
export const recordImageUrl = (mediaId: string): string => `/api/v1/media/${mediaId}`;

export function ImageField({
  entityId,
  recordId,
  fieldKey,
  label,
  mediaId,
  onChange,
}: {
  entityId: string;
  /** `null` while the record does not exist yet. */
  recordId: string | null;
  fieldKey: string;
  label: string;
  mediaId: string | null;
  onChange: (mediaId: string | null) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!recordId) {
    return (
      <div>
        <p className="mb-1 text-xs font-medium">{label}</p>
        <p className="rounded-md border border-dashed px-3 py-4 text-xs text-muted-foreground">
          Save this record first — a photo is stored against the record it belongs to, so there
          is nothing to attach it to yet.
        </p>
      </div>
    );
  }

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const result = await uploadImage<{ mediaId: string }>(file, {
        ticketUrl: `/api/v1/entities/${entityId}/records/${recordId}/media`,
        ticketBody: { fieldKey },
        confirmUrl: (id) => `/api/v1/entities/${entityId}/records/${recordId}/media/${id}`,
        confirmBody: { fieldKey },
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onChange(result.data.mediaId);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
      // So picking the same file twice in a row still fires `change`.
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove() {
    if (!mediaId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/entities/${entityId}/records/${recordId}/media/${mediaId}?fieldKey=${fieldKey}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? "We couldn't remove that image.");
        return;
      }
      onChange(null);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="mb-1 text-xs font-medium">{label}</p>

      <div className="flex items-start gap-3">
        <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
          {mediaId ? (
            // eslint-disable-next-line @next/next/no-img-element -- the byte route 307s to a presigned URL; next/image cannot follow that
            <img src={recordImageUrl(mediaId)} alt={label} className="size-full object-cover" />
          ) : (
            <ImagePlusIcon className="size-5 text-muted-foreground" aria-hidden="true" />
          )}
        </div>

        <div className="flex flex-col items-start gap-1.5">
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES}
            className="hidden"
            aria-label={`Upload ${label}`}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <div className="flex gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              {busy ? "Uploading…" : mediaId ? "Replace" : "Upload"}
            </Button>
            {mediaId ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void remove()}
              >
                <Trash2Icon /> Remove
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            JPEG, PNG, WebP or AVIF, up to 5 MB. Saved as soon as it uploads.
          </p>
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-1.5 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
