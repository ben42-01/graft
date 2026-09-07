"use client";

/**
 * The builder side of a public form's product carousel — pick up to three
 * photos, order them, write their alt text.
 *
 * Three things matter enough to call out:
 *
 *   - **The upload is three requests, and the middle one does not touch this
 *     app.** `POST …/media` returns a presigned URL, the browser `PUT`s the
 *     file straight to the bucket, and `POST …/media/:id` is what makes the
 *     slide real (docs/BACKEND.md §4 — bytes never pass through the API). A
 *     failure between step two and three leaves an unattached object, which
 *     the server treats as an abandoned upload, not as corruption.
 *   - **Order and alt text are saved with an explicit button, uploads are
 *     not.** An upload has no meaningful draft state — the bytes are either in
 *     the bucket or not — whereas alt text is typing, and autosaving every
 *     keystroke to a `PUT` that deletes dropped images is not a forgiving
 *     shape for a control that also removes things.
 *   - **Removal is immediate and permanent.** Dropping an image deletes the
 *     object, so it is confirmed inline rather than being one click deep.
 */
import { useRef, useState } from "react";
import { ArrowLeftIcon, ArrowRightIcon, ImagePlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type CarouselItem = { mediaId: string; alt: string; url: string };

/** Mirrors `MAX_CAROUSEL_IMAGES` / `ALLOWED_IMAGE_TYPES` in the services. */
const MAX_IMAGES = 3;
const ACCEPT = "image/jpeg,image/png,image/webp,image/avif";
const MAX_BYTES = 5 * 1024 * 1024;

export function CarouselEditor({
  formId,
  images = [],
  onChange,
}: {
  formId: string;
  /** Defaulted, not required: a form document written before carousels existed
   * carries no array, and a missing one means "none", never a broken screen. */
  images?: CarouselItem[];
  /** Hands the authoritative server response back to the page. */
  onChange: (next: CarouselItem[]) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<CarouselItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // The page owns the truth; `draft` exists only while the user is mid-edit.
  const items = draft ?? images;
  const dirty = draft !== null;
  const full = items.length >= MAX_IMAGES;

  const edit = (next: CarouselItem[]) => {
    setDraft(next);
    setSaved(false);
  };

  const messageFrom = async (response: Response, fallback: string) => {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return body?.error?.message ?? fallback;
  };

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      if (file.size > MAX_BYTES) {
        setError("That image is larger than 5 MB. Try a smaller one.");
        return;
      }

      const ticketResponse = await fetch(`/api/v1/forms/${formId}/media`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentType: file.type, sizeBytes: file.size }),
      });
      if (!ticketResponse.ok) {
        setError(await messageFrom(ticketResponse, "We couldn't start that upload."));
        return;
      }
      const { data: ticket } = (await ticketResponse.json()) as {
        data: { mediaId: string; uploadUrl: string; contentType: string };
      };

      // Straight to the bucket. `credentials: omit` matters: this is a
      // different origin and the signature is the only authorisation it needs
      // — sending our cookies would be handing them to the storage provider.
      const put = await fetch(ticket.uploadUrl, {
        method: "PUT",
        credentials: "omit",
        // Must match the signed ContentType exactly or the bucket rejects it.
        headers: { "Content-Type": ticket.contentType },
        body: file,
      });
      if (!put.ok) {
        setError("The upload didn't reach storage. Check your connection and try again.");
        return;
      }

      const confirm = await fetch(`/api/v1/forms/${formId}/media/${ticket.mediaId}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        // Alt text is written afterwards, in the row the slide now has.
        body: JSON.stringify({ alt: "" }),
      });
      if (!confirm.ok) {
        setError(await messageFrom(confirm, "The image uploaded but couldn't be attached."));
        return;
      }
      const { data } = (await confirm.json()) as { data: { carousel: CarouselItem[] } };
      setDraft(null);
      onChange(data.carousel);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
      // So picking the same file twice in a row still fires `change`.
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/forms/${formId}/carousel`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          images: items.map((item) => ({ mediaId: item.mediaId, alt: item.alt })),
        }),
      });
      if (!response.ok) {
        setError(await messageFrom(response, "We couldn't save the carousel."));
        return;
      }
      const { data } = (await response.json()) as { data: { carousel: CarouselItem[] } };
      setDraft(null);
      setSaved(true);
      onChange(data.carousel);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(mediaId: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/forms/${formId}/media/${mediaId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) {
        setError(await messageFrom(response, "We couldn't remove that image."));
        return;
      }
      const { data } = (await response.json()) as { data: { carousel: CarouselItem[] } };
      setDraft(null);
      onChange(data.carousel);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    edit(next);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Product images</CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          Up to {MAX_IMAGES} photos, shown as a carousel above the fields on your public form.
          They are what makes a shared link read as an advert rather than a questionnaire.
        </p>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {items.length === 0 ? (
          <p className="rounded-md border border-dashed border-graft-green/30 bg-graft-green/5 px-4 py-6 text-center text-sm text-muted-foreground">
            No images yet. Add one to show visitors what they are booking or buying.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((item, index) => (
              <li
                key={item.mediaId}
                className="flex items-start gap-3 rounded-lg border bg-card p-3"
              >
                {/* Not next/image: a tenant upload behind a redirecting route,
                 * same reasoning as the public page's carousel. */}
                <img
                  src={item.url}
                  alt=""
                  className="size-20 shrink-0 rounded-md border object-cover"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Label htmlFor={`alt-${item.mediaId}`} className="text-xs">
                    Describe this image
                  </Label>
                  <Input
                    id={`alt-${item.mediaId}`}
                    value={item.alt}
                    maxLength={160}
                    placeholder="e.g. 24ft pontoon boat at the dock"
                    onChange={(event) =>
                      edit(
                        items.map((candidate, i) =>
                          i === index ? { ...candidate, alt: event.target.value } : candidate,
                        ),
                      )
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Read aloud to visitors using a screen reader, and shown if the image fails
                    to load.
                  </p>
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Move image ${index + 1} earlier`}
                      disabled={busy || index === 0}
                      onClick={() => move(index, index - 1)}
                    >
                      <ArrowLeftIcon />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Move image ${index + 1} later`}
                      disabled={busy || index === items.length - 1}
                      onClick={() => move(index, index + 1)}
                    >
                      <ArrowRightIcon />
                    </Button>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={busy}
                    onClick={() => void remove(item.mediaId)}
                  >
                    <Trash2Icon /> Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            className="sr-only"
            aria-label="Choose an image to upload"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || full}
            onClick={() => fileRef.current?.click()}
          >
            <ImagePlusIcon /> Add image
          </Button>

          {dirty ? (
            <Button type="button" size="sm" disabled={busy} onClick={() => void save()}>
              Save order &amp; descriptions
            </Button>
          ) : null}

          <p className="text-xs text-muted-foreground">
            {full
              ? `${MAX_IMAGES} of ${MAX_IMAGES} used — remove one to add another.`
              : `${items.length} of ${MAX_IMAGES} used · JPEG, PNG, WebP or AVIF, up to 5 MB.`}
          </p>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {saved && !dirty ? <p className="text-sm text-muted-foreground">Saved.</p> : null}
      </CardContent>
    </Card>
  );
}
