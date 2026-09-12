/**
 * The form carousel — product photos a business attaches to its own public
 * form (docs/Graft.md §4.4, "the link looks like a proper advert").
 *
 * This module is deliberately the seam between `forms.ts` (which owns the
 * ordered `carousel` array on the form document) and `media.ts` (which owns
 * the objects and the storage quota). Neither of those knows about the other;
 * everything that has to be true across both lives here.
 *
 * Two things matter enough to call out:
 *
 *   - **The carousel is the business's own content, not a submitter's.** It is
 *     therefore *not* behind the `form_file_uploads` entitlement, which gates
 *     file fields on submissions — untrusted uploads from anonymous visitors,
 *     a different risk on a different tier (docs/TIERS.md §2.2). A carousel
 *     costs `storage_mb`, which every tier has, and nothing else.
 *   - **Membership is checked against the owner, never against the id.** A
 *     media row names the form that owns it, and every mutation here re-reads
 *     it through the tenant-scoped repository, so a caller cannot attach
 *     another tenant's image by quoting its id — it simply is not found.
 */
import { ObjectId, type Filter } from "mongodb";
import type { Ctx } from "@/server/context";
import { getDb } from "@/server/db/mongo";
import { AppError } from "@/server/http/envelope";
import { parse } from "@/server/http/validate";
import { createRepository, type Repository } from "@/server/repositories/base";
import { findCatalogueDisplayingRecord } from "./public-catalogue";
import type { RecordDoc } from "./records";
import {
  isFormServable,
  MAX_CAROUSEL_IMAGES,
  toCarouselView,
  updateCarouselSchema,
  type CarouselItemView,
  type FormDoc,
} from "./forms";
import {
  confirmUpload as confirmUploadDefault,
  deleteMedia as deleteMediaDefault,
  findReadyMedia,
  getMedia as getMediaDefault,
  listMediaFor as listMediaForDefault,
  requestUpload as requestUploadDefault,
  type MediaDoc,
  type MediaView,
  type RequestUploadInput,
  type UploadTicket,
} from "./media";

export type FormMediaDeps = {
  forms: Repository<FormDoc>;
  requestUpload: (
    ctx: Ctx,
    owner: { type: "form"; id: string },
    input: RequestUploadInput,
  ) => Promise<UploadTicket>;
  confirmUpload: (ctx: Ctx, mediaId: string) => Promise<MediaView>;
  deleteMedia: (ctx: Ctx, mediaId: string) => Promise<void>;
  getMedia: (ctx: Ctx, mediaId: string) => Promise<(MediaDoc & { _id: ObjectId }) | null>;
  listMediaFor: (
    ctx: Ctx,
    owner: { type: "form"; id: string },
  ) => Promise<(MediaDoc & { _id: ObjectId })[]>;
};

function resolveDeps(overrides: Partial<FormMediaDeps> = {}): FormMediaDeps {
  return {
    forms: overrides.forms ?? createRepository<FormDoc>("forms"),
    requestUpload: overrides.requestUpload ?? requestUploadDefault,
    confirmUpload: overrides.confirmUpload ?? confirmUploadDefault,
    deleteMedia: overrides.deleteMedia ?? deleteMediaDefault,
    getMedia: overrides.getMedia ?? getMediaDefault,
    listMediaFor: overrides.listMediaFor ?? listMediaForDefault,
  };
}

async function findFormOrThrow(deps: FormMediaDeps, ctx: Ctx, formId: string) {
  const form = await deps.forms.findById(ctx, formId);
  if (!form) throw new AppError("NOT_FOUND", "Form not found");
  return form;
}

const carouselOf = (form: FormDoc): { mediaId: ObjectId; alt: string }[] => form.carousel ?? [];

/**
 * Refuses before minting a URL when the carousel is already full, so an
 * upload that could never be attached never costs the tenant bandwidth or
 * storage. The check races with a concurrent attach, which is why
 * `attachImage` re-checks under the write.
 */
export async function requestFormImageUpload(
  ctx: Ctx,
  formId: string,
  input: RequestUploadInput,
  overrides: Partial<FormMediaDeps> = {},
): Promise<UploadTicket> {
  const deps = resolveDeps(overrides);
  const form = await findFormOrThrow(deps, ctx, formId);
  if (carouselOf(form).length >= MAX_CAROUSEL_IMAGES) {
    throw new AppError(
      "CONFLICT",
      `A form carousel holds at most ${MAX_CAROUSEL_IMAGES} images. Remove one first.`,
    );
  }
  return deps.requestUpload(ctx, { type: "form", id: formId }, input);
}

/**
 * Confirms the upload (which is what charges storage and verifies the bytes),
 * then appends the slide. The append is a guarded `$push`: `carousel.3` must
 * not exist, so two uploads finishing at once cannot both land on a
 * two-image carousel and produce four slides.
 */
export async function attachFormImage(
  ctx: Ctx,
  formId: string,
  mediaId: string,
  alt: string,
  overrides: Partial<FormMediaDeps> = {},
): Promise<CarouselItemView[]> {
  const deps = resolveDeps(overrides);
  const form = await findFormOrThrow(deps, ctx, formId);

  // Idempotent: the browser may retry a confirm whose response it never saw.
  if (carouselOf(form).some((item) => item.mediaId.toHexString() === mediaId)) {
    return toCarouselView(carouselOf(form));
  }

  // Ownership is checked against the media row's own `ownerId`, not against
  // the id in the URL: tenant scoping already rules out another tenant, and
  // this rules out another *form* of the same tenant.
  const media = await deps.getMedia(ctx, mediaId);
  if (!media || media.ownerType !== "form" || media.ownerId.toHexString() !== formId) {
    throw new AppError("NOT_FOUND", "Upload not found");
  }

  await deps.confirmUpload(ctx, mediaId);

  const updated = await deps.forms.updateOne(
    ctx,
    {
      _id: new ObjectId(formId),
      // The guard: only append when there is room for a slide at this index.
      [`carousel.${MAX_CAROUSEL_IMAGES - 1}`]: { $exists: false },
    } as Filter<FormDoc>,
    { $push: { carousel: { mediaId: new ObjectId(mediaId), alt } } } as never,
  );

  if (!updated) {
    // Lost the race, or the form vanished. The object exists and is charged,
    // so it is removed rather than left as storage nothing references.
    await deps.deleteMedia(ctx, mediaId);
    throw new AppError(
      "CONFLICT",
      `A form carousel holds at most ${MAX_CAROUSEL_IMAGES} images. Remove one first.`,
    );
  }
  return toCarouselView(carouselOf(updated));
}

/**
 * Sets the whole array at once: this is reorder, alt-text edit and removal in
 * one operation, because all three are "the carousel is now exactly this".
 * Every id must already be `ready` media owned by this form — a client cannot
 * introduce a slide here, only rearrange what it uploaded.
 *
 * An image dropped from the array is deleted from the bucket too. Keeping it
 * would leave storage charged against a tenant with no screen that can ever
 * show it to them again.
 */
export async function updateFormCarousel(
  ctx: Ctx,
  formId: string,
  input: unknown,
  overrides: Partial<FormMediaDeps> = {},
): Promise<CarouselItemView[]> {
  const deps = resolveDeps(overrides);
  const { images } = parse(updateCarouselSchema, input, "body");
  const form = await findFormOrThrow(deps, ctx, formId);

  const owned = new Set(
    (await deps.listMediaFor(ctx, { type: "form", id: formId })).map((m) =>
      m._id.toHexString(),
    ),
  );
  const seen = new Set<string>();
  for (const image of images) {
    if (!owned.has(image.mediaId)) {
      throw new AppError("VALIDATION_FAILED", "Invalid request body", {
        source: "body",
        fields: { images: "That image does not belong to this form" },
      });
    }
    if (seen.has(image.mediaId)) {
      throw new AppError("VALIDATION_FAILED", "Invalid request body", {
        source: "body",
        fields: { images: "The same image cannot appear twice" },
      });
    }
    seen.add(image.mediaId);
  }

  const updated = await deps.forms.updateOne(
    ctx,
    { _id: new ObjectId(formId) } as Filter<FormDoc>,
    {
      $set: {
        carousel: images.map((image) => ({
          mediaId: new ObjectId(image.mediaId),
          alt: image.alt,
        })),
      },
    },
  );
  if (!updated) throw new AppError("NOT_FOUND", "Form not found");

  // Whatever was on the carousel before and is not on it now is now orphaned.
  const dropped = carouselOf(form)
    .map((item) => item.mediaId.toHexString())
    .filter((id) => !seen.has(id));
  for (const mediaId of dropped) {
    await deps.deleteMedia(ctx, mediaId);
  }

  return toCarouselView(carouselOf(updated));
}

/** Detaches one slide and deletes its object — the single-image shortcut. */
export async function removeFormImage(
  ctx: Ctx,
  formId: string,
  mediaId: string,
  overrides: Partial<FormMediaDeps> = {},
): Promise<CarouselItemView[]> {
  const deps = resolveDeps(overrides);
  const form = await findFormOrThrow(deps, ctx, formId);
  const remaining = carouselOf(form).filter((item) => item.mediaId.toHexString() !== mediaId);
  if (remaining.length === carouselOf(form).length) {
    throw new AppError("NOT_FOUND", "Image not found on this form");
  }

  const updated = await deps.forms.updateOne(
    ctx,
    { _id: new ObjectId(formId) } as Filter<FormDoc>,
    {
      $set: { carousel: remaining },
    },
  );
  if (!updated) throw new AppError("NOT_FOUND", "Form not found");
  await deps.deleteMedia(ctx, mediaId);
  return toCarouselView(remaining);
}

/**
 * The unauthenticated read path behind `/api/v1/public/media/:mediaId`.
 *
 * There is no ctx — a visitor presents an id, not a token — so this reads the
 * collections directly, the same reasoning `forms.findByPublicSlug` documents.
 * **Serving is decided by the owner, not by the media row.** There are now two
 * kinds of owner and they answer the same question differently:
 *
 *   - a `form` image is public while the form that owns it is published *and*
 *     enabled *and* still lists the image on its carousel;
 *   - a `record` image is public while some published, enabled form shows that
 *     record in its catalogue *through that very field*
 *     (`findCatalogueDisplayingRecord`).
 *
 * So unpublishing a form, hitting its kill switch, turning catalogue mode off,
 * pointing `imageField` somewhere else or clearing the field all take the
 * picture down with them. Unknown, unattached, unpublished and killed collapse
 * to `null` alike — the same 404 the form page itself gives.
 */
export type PublicMediaDeps = {
  findReadyMedia: (mediaId: string) => Promise<(MediaDoc & { _id: ObjectId }) | null>;
  /** Scoped by the media row's own tenant, never by anything a caller sent. */
  findOwningForm: (
    formId: ObjectId,
    tenantId: ObjectId,
  ) => Promise<(FormDoc & { _id: ObjectId }) | null>;
  findOwningRecord: (
    recordId: ObjectId,
    tenantId: ObjectId,
  ) => Promise<(RecordDoc & { _id: ObjectId }) | null>;
  isRecordOnDisplay: (
    record: RecordDoc & { _id: ObjectId },
    mediaId: string,
  ) => Promise<boolean>;
};

function resolvePublicDeps(overrides: Partial<PublicMediaDeps> = {}): PublicMediaDeps {
  return {
    findReadyMedia: overrides.findReadyMedia ?? findReadyMedia,
    findOwningForm:
      overrides.findOwningForm ??
      (async (formId, tenantId) => {
        const db = await getDb();
        return db
          .collection<FormDoc>("forms")
          .findOne({ _id: formId, tenantId, deletedAt: null });
      }),
    findOwningRecord:
      overrides.findOwningRecord ??
      (async (recordId, tenantId) => {
        const db = await getDb();
        return db
          .collection<RecordDoc>("records")
          .findOne({ _id: recordId, tenantId, deletedAt: null });
      }),
    isRecordOnDisplay: overrides.isRecordOnDisplay ?? findCatalogueDisplayingRecord,
  };
}

export async function findServablePublicMedia(
  mediaId: string,
  overrides: Partial<PublicMediaDeps> = {},
): Promise<{ key: string; contentType: string } | null> {
  const deps = resolvePublicDeps(overrides);
  const media = await deps.findReadyMedia(mediaId);
  if (!media) return null;

  const servable = { key: media.key, contentType: media.contentType };

  if (media.ownerType === "form") {
    const form = await deps.findOwningForm(media.ownerId, media.tenantId);
    if (!form || !isFormServable(form)) return null;

    // Still attached: a slide removed from the carousel is no longer public
    // even if its object has not been swept yet.
    const attached = (form.carousel ?? []).some(
      (item) => item.mediaId.toHexString() === media._id.toHexString(),
    );
    return attached ? servable : null;
  }

  if (media.ownerType === "record") {
    const record = await deps.findOwningRecord(media.ownerId, media.tenantId);
    if (!record) return null;
    // Not "does a catalogue exist" but "is this record on display through the
    // field this image sits in" — the narrowest question that authorises it.
    return (await deps.isRecordOnDisplay(record, media._id.toHexString())) ? servable : null;
  }

  // An owner kind this build does not know how to authorise is not served.
  return null;
}
