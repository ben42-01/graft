/**
 * Media — tenant-owned image objects and the two-step upload that creates them
 * (docs/BACKEND.md §4, §5).
 *
 * Four things matter enough to call out:
 *
 *   - **Upload is two calls, not one.** `requestUpload` records intent and
 *     mints a presigned PUT; `confirmUpload` is what makes the object real.
 *     Between them the browser talks to the bucket and the app hears nothing,
 *     so a `pending` row whose object never arrived is the normal shape of an
 *     abandoned upload — not corruption. Only `ready` rows are ever served.
 *   - **The client's claimed size is a hint; the bucket's is the fact.**
 *     `requestUpload` rejects an obviously-too-large declaration early to save
 *     a pointless round trip, but `confirmUpload` re-reads the real
 *     `ContentLength` with a HEAD and refuses the object if it overran. A
 *     signed URL cannot enforce a size on its own, so the check has to happen
 *     after the bytes land.
 *   - **Storage quota is charged on confirm, in whole megabytes.** Charging at
 *     request time would bill for uploads that never happened; charging bytes
 *     would need a meter with a range no `Int32` counter wants. `storage_mb`
 *     is a lifetime counter (meters.ts `METERS`), so deleting media does not
 *     refund it — the same convention `entities`, `records` and `active_forms`
 *     already use.
 *   - **`image/svg+xml` is not an image here.** An SVG is a script host, and
 *     these objects are served to anonymous visitors on a public form page.
 *     The allow-list is raster formats only, and it is an allow-list rather
 *     than a deny-list so a new content type is refused by default.
 */
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import { createRepository, type Repository } from "@/server/repositories/base";
import { s3ObjectStore, UPLOAD_URL_TTL_SECONDS, type ObjectStore } from "@/server/storage/s3";
import { consumeQuota as consumeQuotaDefault, type QuotaResult } from "./meters";

/** Raster formats only — see the module docs for why SVG is absent. */
export const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
] as const;

export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

/**
 * What a batch record import may be (GRAFT-25.1, docs/TIERS.md §2.3). An
 * import file is tenant business data the *server* parses, never anything a
 * browser is handed back, so the risk an SVG poses to the image list does not
 * apply — but it is still an allow-list, so XLSX and friends are refused by
 * default rather than by omission.
 */
export const ALLOWED_IMPORT_TYPES = ["text/csv", "application/json"] as const;

export type AllowedImportType = (typeof ALLOWED_IMPORT_TYPES)[number];
export type AllowedContentType = AllowedImageType | AllowedImportType;

const EXTENSIONS: Record<AllowedContentType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "text/csv": "csv",
  "application/json": "json",
};

/**
 * Generous for a product photo off a phone, small enough that a tenant cannot
 * spend a Free plan's 250 MB in a handful of requests.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * An import file is text, and 10,000 rows of it (the Premium per-import
 * ceiling) is nowhere near this — the cap is here so a signed URL cannot be
 * spent filling the bucket, not to bound a legitimate import.
 */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

const objectIdHex = z.string().regex(/^[0-9a-f]{24}$/i, "Expected a 24-character id");

export const requestUploadSchema = z.object({
  contentType: z.enum(ALLOWED_IMAGE_TYPES),
  /** The browser's `File.size`, checked again against the bucket on confirm. */
  sizeBytes: z.number().int().positive().max(MAX_IMAGE_BYTES),
});

/** The same two calls, for a file the server will parse rather than serve. */
export const requestImportUploadSchema = z.object({
  contentType: z.enum(ALLOWED_IMPORT_TYPES),
  sizeBytes: z.number().int().positive().max(MAX_IMPORT_BYTES),
});

export type RequestUploadInput = z.input<typeof requestUploadSchema>;
export type RequestImportUploadInput = z.input<typeof requestImportUploadSchema>;

/**
 * What `requestUpload` accepts, across both owner shapes. The allow-list and
 * the ceiling are still chosen by the owner (`uploadSchemaFor`), not by the
 * caller — this union only stops an import's `text/csv` from having to be cast
 * through the image schema's type on the way in.
 */
export type RequestAnyUploadInput = RequestUploadInput | RequestImportUploadInput;

/**
 * One owner kind, one allow-list and one ceiling. Kept as functions of the
 * owner rather than as a parameter the caller passes, so a new call site
 * cannot pick its own limits.
 */
export const uploadSchemaFor = (owner: MediaOwner) =>
  owner === "import" ? requestImportUploadSchema : requestUploadSchema;

export const maxBytesFor = (owner: MediaOwner): number =>
  owner === "import" ? MAX_IMPORT_BYTES : MAX_IMAGE_BYTES;

export const mediaIdParamSchema = z.object({ mediaId: objectIdHex });

/**
 * What a media object can hang off. `form` is the carousel/hero image the
 * business attaches to its own advert; `record` is a picture of the thing the
 * record describes, which is what makes a public form browsable as a
 * catalogue. Both are the tenant's own content — neither is an untrusted
 * upload from a submitter, which is a different risk on a different tier
 * (`form_file_uploads`, docs/TIERS.md §2.2).
 *
 * Adding a kind here is additive by design: `objectKey` namespaces by owner,
 * and every authorization decision is made against the owner document, never
 * against the media row alone.
 */
export const MEDIA_OWNERS = ["form", "record", "import"] as const;
export type MediaOwner = (typeof MEDIA_OWNERS)[number];

export type MediaStatus = "pending" | "ready";

export type MediaDoc = {
  tenantId: ObjectId;
  /** The object key in the bucket. Derived here, never supplied by a client. */
  key: string;
  contentType: AllowedContentType;
  /** 0 until `confirmUpload` reads the real length from the bucket. */
  sizeBytes: number;
  status: MediaStatus;
  ownerType: MediaOwner;
  ownerId: ObjectId;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MediaView = {
  id: string;
  contentType: string;
  sizeBytes: number;
  status: MediaStatus;
  /** Where a browser fetches the bytes — this app, never the bucket directly. */
  url: string;
};

export type UploadTicket = {
  mediaId: string;
  uploadUrl: string;
  /** The header the browser MUST send; it is part of the signature. */
  contentType: AllowedContentType;
  expiresInSeconds: number;
};

const mediaRepo = createRepository<MediaDoc>("media");

export const mediaUrl = (mediaId: string): string => `/api/v1/public/media/${mediaId}`;

export function toMediaView(doc: MediaDoc & { _id: ObjectId }): MediaView {
  return {
    id: doc._id.toString(),
    contentType: doc.contentType,
    sizeBytes: doc.sizeBytes,
    status: doc.status,
    url: mediaUrl(doc._id.toString()),
  };
}

export type MediaDeps = {
  repo: Repository<MediaDoc>;
  store: ObjectStore;
  consumeQuota: (ctx: Ctx, amount: number) => Promise<QuotaResult>;
  /** Test seam: the random half of an object key. */
  randomKey: () => string;
};

function resolveDeps(overrides: Partial<MediaDeps> = {}): MediaDeps {
  return {
    repo: overrides.repo ?? mediaRepo,
    store: overrides.store ?? s3ObjectStore(),
    consumeQuota:
      overrides.consumeQuota ??
      ((ctx, amount) => consumeQuotaDefault(ctx, "storage_mb", amount)),
    randomKey: overrides.randomKey ?? (() => new ObjectId().toHexString()),
  };
}

/**
 * Keys are namespaced by tenant so a bucket listing is readable by a human
 * during an incident, and so a future per-tenant lifecycle rule or bucket
 * split has a prefix to work from. Nothing about access control depends on
 * the key — that is the `tenantId` on the document — because a key is a
 * guessable string and an authorization decision must never rest on one.
 */
function objectKey(
  tenantId: string,
  owner: MediaOwner,
  ownerId: string,
  random: string,
  contentType: AllowedContentType,
): string {
  return `tenants/${tenantId}/${owner}s/${ownerId}/${random}.${EXTENSIONS[contentType]}`;
}

/** Whole megabytes, rounded up, never zero — a 12 KB image still costs storage. */
export const megabytesFor = (bytes: number): number =>
  Math.max(1, Math.ceil(bytes / (1024 * 1024)));

/**
 * Step one: record the intent and hand back a URL the browser uploads to
 * directly. Nothing is metered yet and no object exists.
 */
export async function requestUpload(
  ctx: Ctx,
  owner: { type: MediaOwner; id: string },
  input: RequestAnyUploadInput,
  overrides: Partial<MediaDeps> = {},
): Promise<UploadTicket> {
  const deps = resolveDeps(overrides);
  // `sizeBytes` is validated by the schema (a declaration above the cap is a
  // 400 here rather than a wasted upload) but deliberately not stored: the
  // only size that ever gets recorded is the one the bucket reports on confirm.
  const { contentType } = uploadSchemaFor(owner.type).parse(input);

  const key = objectKey(ctx.tenantId, owner.type, owner.id, deps.randomKey(), contentType);
  const doc = await deps.repo.insertOne(ctx, {
    key,
    contentType,
    sizeBytes: 0,
    status: "pending",
    ownerType: owner.type,
    ownerId: new ObjectId(owner.id),
    deletedAt: null,
  });

  return {
    mediaId: doc._id.toString(),
    uploadUrl: await deps.store.presignPut(key, contentType),
    contentType,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    // `sizeBytes` is deliberately not echoed: the browser already knows what it
    // sent, and the only size that matters from here is the bucket's.
  };
}

/**
 * Step two: the bytes have landed, so verify them against the bucket, charge
 * storage and promote the row to `ready`. Idempotent — confirming an already
 * confirmed upload returns the same view without charging twice.
 */
export async function confirmUpload(
  ctx: Ctx,
  mediaId: string,
  overrides: Partial<MediaDeps> = {},
): Promise<MediaView> {
  const deps = resolveDeps(overrides);
  const doc = await deps.repo.findById(ctx, mediaId);
  if (!doc) throw new AppError("NOT_FOUND", "Upload not found");
  if (doc.status === "ready") return toMediaView(doc);

  const head = await deps.store.head(doc.key);
  if (!head) {
    throw new AppError("VALIDATION_FAILED", "No file was uploaded to this URL");
  }
  if (head.sizeBytes > maxBytesFor(doc.ownerType)) {
    // The object is unusable and nothing has been charged for it; leaving it in
    // the bucket would be a way to store bytes for free.
    await deps.store.remove(doc.key);
    await deps.repo.softDelete(ctx, mediaId);
    throw new AppError(
      "PAYLOAD_TOO_LARGE",
      doc.ownerType === "import"
        ? "That file is larger than 25 MB"
        : "That image is larger than 5 MB",
    );
  }

  // Charged before the promotion, not after: if the quota refuses, the row must
  // still be `pending` so nothing can serve it.
  await deps.consumeQuota(ctx, megabytesFor(head.sizeBytes));

  const updated = await deps.repo.updateOne(
    ctx,
    { _id: new ObjectId(mediaId), status: "pending" },
    { $set: { status: "ready", sizeBytes: head.sizeBytes } },
  );
  if (!updated) throw new AppError("NOT_FOUND", "Upload not found");
  return toMediaView(updated);
}

/**
 * Hard-deletes the object and soft-deletes the row. The bucket delete happens
 * first: a row without an object is a dangling reference the reader already
 * tolerates (`readable` returns null), whereas an object without a row is
 * billed storage nothing will ever reclaim.
 */
export async function deleteMedia(
  ctx: Ctx,
  mediaId: string,
  overrides: Partial<MediaDeps> = {},
): Promise<void> {
  const deps = resolveDeps(overrides);
  const doc = await deps.repo.findById(ctx, mediaId);
  if (!doc) throw new AppError("NOT_FOUND", "Image not found");
  await deps.store.remove(doc.key);
  await deps.repo.softDelete(ctx, mediaId);
}

/** One media row, whatever its status — tenant-scoped, so another tenant's id is simply absent. */
export async function getMedia(
  ctx: Ctx,
  mediaId: string,
  overrides: Partial<MediaDeps> = {},
): Promise<(MediaDoc & { _id: ObjectId }) | null> {
  if (!ObjectId.isValid(mediaId)) return null;
  return resolveDeps(overrides).repo.findById(ctx, mediaId);
}

/** The `ready` rows for one owner, in insertion order. */
export async function listMediaFor(
  ctx: Ctx,
  owner: { type: MediaOwner; id: string },
  overrides: Partial<MediaDeps> = {},
): Promise<(MediaDoc & { _id: ObjectId })[]> {
  const deps = resolveDeps(overrides);
  return deps.repo.find(
    ctx,
    { ownerType: owner.type, ownerId: new ObjectId(owner.id), status: "ready" },
    { sort: { _id: 1 } },
  );
}

/**
 * The unauthenticated read path, used by the public form page. There is no ctx
 * here — a visitor presents an id, not a token — so this reads the collection
 * directly, the same reasoning `forms.findByPublicSlug` and `accounts-store.ts`
 * document. **It deliberately does not decide whether the media may be served**:
 * that depends on the owner (a published, enabled form), and the caller that
 * knows the owner is the one that must ask.
 */
export async function findReadyMedia(
  mediaId: string,
  overrides: Partial<MediaDeps> = {},
): Promise<(MediaDoc & { _id: ObjectId }) | null> {
  if (!ObjectId.isValid(mediaId)) return null;
  const deps = resolveDeps(overrides);
  const collection = await deps.repo.collection();
  return collection.findOne({
    _id: new ObjectId(mediaId),
    status: "ready",
    deletedAt: null,
  });
}

/**
 * The bytes of a `ready` object, as text, for the server to parse
 * (GRAFT-25.1 AC9). Tenant-scoped through the repository, so another tenant's
 * media id is simply absent — and restricted to `import` objects, because
 * nothing else in the system has a reason to read an object's content into the
 * app process.
 */
export async function readImportText(
  ctx: Ctx,
  mediaId: string,
  overrides: Partial<MediaDeps> = {},
): Promise<{ text: string; contentType: AllowedContentType }> {
  const deps = resolveDeps(overrides);
  const doc = ObjectId.isValid(mediaId) ? await deps.repo.findById(ctx, mediaId) : null;
  if (!doc || doc.ownerType !== "import") throw new AppError("NOT_FOUND", "Upload not found");
  if (doc.status !== "ready") {
    throw new AppError("VALIDATION_FAILED", "That upload has not been confirmed yet", {
      source: "body",
      fields: { mediaId: "Confirm the upload before starting the import" },
    });
  }
  const text = await deps.store.getText(doc.key);
  if (text === null) throw new AppError("NOT_FOUND", "Upload not found");
  return { text, contentType: doc.contentType };
}

/** A time-limited URL for the bytes themselves. */
export async function presignedReadUrl(
  key: string,
  overrides: Partial<MediaDeps> = {},
): Promise<string> {
  return resolveDeps(overrides).store.presignGet(key);
}
