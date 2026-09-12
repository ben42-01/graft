/**
 * Record images — the picture of the thing a record *describes*.
 *
 * This is the seam between `records.ts` (which owns a record's `data` bag),
 * `entities.ts` (which declares that one of its fields is an `image`) and
 * `media.ts` (which owns the objects and the storage quota), the same way
 * `form-media.ts` is that seam for the form carousel. Everything that has to
 * be true across all three lives here.
 *
 * Four things matter enough to call out:
 *
 *   - **The value stored on the record is a media id, never a URL.** A URL
 *     would be an unauthenticated, unexpiring reference to a private bucket
 *     sitting inside tenant data; an id is resolved to a URL at whichever
 *     edge renders it, by whichever authorization rule that edge applies.
 *   - **An image field holds exactly one image.** Attaching over an existing
 *     one replaces it and deletes the old object, because a record field is
 *     a single value and orphaned bytes are storage the tenant is charged for
 *     with no screen that can ever show it to them again. The three-slide
 *     carousel belongs to the *form*; the record has one picture of itself.
 *   - **Ownership is checked against the media row's own owner, never the id
 *     in the URL.** Tenant scoping already rules out another tenant; this
 *     rules out another *record* of the same tenant.
 *   - **The field must be declared `image` on the entity.** Writing a media
 *     id into a `text` field would typecheck at the Mongo level and produce
 *     a record whose compiled schema rejects it on the next ordinary update.
 */
import { ObjectId, type Filter } from "mongodb";
import type { Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import { createRepository, type Repository } from "@/server/repositories/base";
import { getEntity as getEntityDefault, isMediaField, type EntityView } from "./entities";
import type { RecordDoc } from "./records";
import {
  confirmUpload as confirmUploadDefault,
  deleteMedia as deleteMediaDefault,
  getMedia as getMediaDefault,
  mediaUrl,
  requestUpload as requestUploadDefault,
  type MediaDoc,
  type MediaView,
  type RequestUploadInput,
  type UploadTicket,
} from "./media";

export type RecordMediaDeps = {
  records: Repository<RecordDoc>;
  getEntity: (ctx: Ctx, entityId: string) => Promise<EntityView>;
  requestUpload: (
    ctx: Ctx,
    owner: { type: "record"; id: string },
    input: RequestUploadInput,
  ) => Promise<UploadTicket>;
  confirmUpload: (ctx: Ctx, mediaId: string) => Promise<MediaView>;
  deleteMedia: (ctx: Ctx, mediaId: string) => Promise<void>;
  getMedia: (ctx: Ctx, mediaId: string) => Promise<(MediaDoc & { _id: ObjectId }) | null>;
};

function resolveDeps(overrides: Partial<RecordMediaDeps> = {}): RecordMediaDeps {
  return {
    records: overrides.records ?? createRepository<RecordDoc>("records"),
    getEntity: overrides.getEntity ?? ((ctx, entityId) => getEntityDefault(ctx, entityId)),
    requestUpload: overrides.requestUpload ?? requestUploadDefault,
    confirmUpload: overrides.confirmUpload ?? confirmUploadDefault,
    deleteMedia: overrides.deleteMedia ?? deleteMediaDefault,
    getMedia: overrides.getMedia ?? getMediaDefault,
  };
}

/**
 * Resolves the (entity, record, field) triple every operation here starts
 * from, refusing each way it can be wrong with the error that describes it.
 * A record belonging to a *different* entity of the same tenant is a 404
 * rather than a 403: the caller asked for a record that does not exist at the
 * address it gave.
 */
async function resolveTarget(
  deps: RecordMediaDeps,
  ctx: Ctx,
  entityId: string,
  recordId: string,
  fieldKey: string,
): Promise<{ record: RecordDoc & { _id: ObjectId } }> {
  const entity = await deps.getEntity(ctx, entityId);

  const field = entity.fields.find((candidate) => candidate.key === fieldKey);
  if (!field) {
    throw new AppError("VALIDATION_FAILED", "Invalid request", {
      source: "params",
      fields: { fieldKey: `Unknown field "${fieldKey}" on this entity` },
    });
  }
  if (!isMediaField(field)) {
    throw new AppError("VALIDATION_FAILED", "Invalid request", {
      source: "params",
      fields: { fieldKey: `Field "${fieldKey}" does not hold an image` },
    });
  }

  const record = await deps.records.findById(ctx, recordId);
  if (!record || record.entityDefId.toHexString() !== entityId || record.deletedAt !== null) {
    throw new AppError("NOT_FOUND", "Record not found");
  }

  return { record };
}

/** The media id currently in a record's image field, if any. */
function currentMediaId(record: RecordDoc, fieldKey: string): string | null {
  const value = record.data[fieldKey];
  return typeof value === "string" && /^[0-9a-f]{24}$/i.test(value) ? value : null;
}

/**
 * Step one — record the intent and hand back a presigned PUT. Nothing is
 * metered and no object exists until the confirm.
 */
export async function requestRecordImageUpload(
  ctx: Ctx,
  entityId: string,
  recordId: string,
  fieldKey: string,
  input: RequestUploadInput,
  overrides: Partial<RecordMediaDeps> = {},
): Promise<UploadTicket> {
  const deps = resolveDeps(overrides);
  await resolveTarget(deps, ctx, entityId, recordId, fieldKey);
  return deps.requestUpload(ctx, { type: "record", id: recordId }, input);
}

/**
 * Step two — the bytes have landed: verify and charge them (`confirmUpload`),
 * then point the field at the new object and delete whatever it pointed at
 * before.
 *
 * The old object is deleted *after* the field has been repointed, never
 * before: if the write fails, the record still references an image that
 * exists. The reverse order would turn a failed update into a broken record.
 */
export async function attachRecordImage(
  ctx: Ctx,
  entityId: string,
  recordId: string,
  fieldKey: string,
  mediaId: string,
  overrides: Partial<RecordMediaDeps> = {},
): Promise<{ mediaId: string; url: string }> {
  const deps = resolveDeps(overrides);
  const { record } = await resolveTarget(deps, ctx, entityId, recordId, fieldKey);

  // Idempotent: the browser may retry a confirm whose response it never saw.
  if (currentMediaId(record, fieldKey) === mediaId) {
    return { mediaId, url: mediaUrl(mediaId) };
  }

  const media = await deps.getMedia(ctx, mediaId);
  if (!media || media.ownerType !== "record" || media.ownerId.toHexString() !== recordId) {
    throw new AppError("NOT_FOUND", "Upload not found");
  }

  await deps.confirmUpload(ctx, mediaId);

  const updated = await deps.records.updateOne(
    ctx,
    { _id: record._id, deletedAt: null } as Filter<RecordDoc>,
    { $set: { [`data.${fieldKey}`]: mediaId } } as never,
  );
  if (!updated) {
    // The record vanished between the read and the write. The object is
    // charged and now referenced by nothing, so it is removed rather than
    // left as storage that can never be reclaimed.
    await deps.deleteMedia(ctx, mediaId);
    throw new AppError("NOT_FOUND", "Record not found");
  }

  const previous = currentMediaId(record, fieldKey);
  if (previous) await deps.deleteMedia(ctx, previous).catch(() => undefined);

  return { mediaId, url: mediaUrl(mediaId) };
}

/** Clears the field and deletes the object. A field that is already empty is
 * a 404 — there is nothing at the address the caller named. */
export async function removeRecordImage(
  ctx: Ctx,
  entityId: string,
  recordId: string,
  fieldKey: string,
  overrides: Partial<RecordMediaDeps> = {},
): Promise<void> {
  const deps = resolveDeps(overrides);
  const { record } = await resolveTarget(deps, ctx, entityId, recordId, fieldKey);

  const mediaId = currentMediaId(record, fieldKey);
  if (!mediaId) throw new AppError("NOT_FOUND", "No image on this field");

  const updated = await deps.records.updateOne(
    ctx,
    { _id: record._id, deletedAt: null } as Filter<RecordDoc>,
    { $unset: { [`data.${fieldKey}`]: "" } } as never,
  );
  if (!updated) throw new AppError("NOT_FOUND", "Record not found");

  await deps.deleteMedia(ctx, mediaId).catch(() => undefined);
}
