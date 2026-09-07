/**
 * The form carousel — unit coverage.
 *
 * The invariants worth pinning are the ones that span two collections and so
 * cannot be enforced by either service alone: the three-image ceiling, the
 * rule that a slide's media must belong to *this* form, and the promise that
 * an image dropped from the carousel does not stay charged as storage.
 * Persistence and cross-tenant scoping are proven for real by
 * bruno/forms/carousel-*.bru.
 */
import { ObjectId, type WithId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import type { Repository } from "@/server/repositories/base";
import type { FieldDef } from "@/server/services/entities";
import {
  attachFormImage,
  findServablePublicMedia,
  removeFormImage,
  updateFormCarousel,
  requestFormImageUpload,
  type FormMediaDeps,
  type PublicMediaDeps,
} from "./form-media";
import type { FormDoc } from "./forms";
import type { MediaDoc, MediaView, UploadTicket } from "./media";

const TENANT = "000000000000000000000001";
const USER = "00000000000000000000000b";
const ENTITY_ID = "000000000000000000000021";
const FORM_ID = "000000000000000000000031";
const OTHER_FORM_ID = "000000000000000000000032";

const ctx: Ctx = createContext({
  requestId: "req-form-media",
  tenantId: TENANT,
  userId: USER,
  roles: ["owner"],
  tier: "free",
});

const field: FieldDef = { key: "name", label: "Name", type: "text", required: true };

const mediaId = (n: number) => `0000000000000000000000${n.toString().padStart(2, "0")}`;

const seedForm = (over: Partial<WithId<FormDoc>> = {}): WithId<FormDoc> => ({
  _id: new ObjectId(FORM_ID),
  tenantId: new ObjectId(TENANT),
  entityDefId: new ObjectId(ENTITY_ID),
  name: "Booking Request",
  slug: "booking-request",
  publicSlug: null,
  visibility: "public",
  published: false,
  enabled: true,
  killSwitchAt: null,
  killSwitchBy: null,
  fields: [field],
  carousel: [],
  showBadge: true,
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

const seedMedia = (id: string, over: Partial<WithId<MediaDoc>> = {}): WithId<MediaDoc> => ({
  _id: new ObjectId(id),
  tenantId: new ObjectId(TENANT),
  key: `tenants/${TENANT}/forms/${FORM_ID}/${id}.png`,
  contentType: "image/png",
  sizeBytes: 4096,
  status: "ready",
  ownerType: "form",
  ownerId: new ObjectId(FORM_ID),
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

/**
 * A forms repository that honours the one filter this module relies on for
 * correctness: the `carousel.N does not exist` guard that makes the append
 * safe under a race.
 */
function fakeFormsRepo(seed: WithId<FormDoc>) {
  let doc = seed;
  const repo: Repository<FormDoc> = {
    collectionName: "forms",
    collection: vi.fn() as unknown as Repository<FormDoc>["collection"],
    async find() {
      return [doc];
    },
    async findOne() {
      return doc;
    },
    async findById(_ctx, id) {
      return id.toString() === doc._id.toHexString() ? doc : null;
    },
    async count() {
      return 1;
    },
    async insertOne() {
      throw new Error("not used");
    },
    async updateOne(_ctx, filter, update) {
      const f = filter as Record<string, unknown>;
      const guard = f["carousel.2"] as { $exists: boolean } | undefined;
      if (guard && (doc.carousel ?? []).length >= 3) return null;

      const push = (update as Record<string, { carousel?: unknown }>).$push;
      if (push?.carousel) {
        doc = {
          ...doc,
          carousel: [
            ...(doc.carousel ?? []),
            push.carousel as { mediaId: ObjectId; alt: string },
          ],
        };
        return doc;
      }
      doc = { ...doc, ...(update.$set ?? {}) } as WithId<FormDoc>;
      return doc;
    },
    async softDelete() {
      return true;
    },
    async listPage() {
      return { items: [doc], meta: { limit: 25, hasMore: false, cursor: null } };
    },
  };
  return { repo, current: () => doc };
}

function deps(
  form: WithId<FormDoc>,
  media: WithId<MediaDoc>[],
  over: Partial<FormMediaDeps> = {},
): {
  deps: Partial<FormMediaDeps>;
  forms: ReturnType<typeof fakeFormsRepo>;
  deleted: string[];
} {
  const forms = fakeFormsRepo(form);
  const deleted: string[] = [];
  const byId = new Map(media.map((m) => [m._id.toHexString(), m]));

  return {
    forms,
    deleted,
    deps: {
      forms: forms.repo,
      requestUpload: vi.fn(async (): Promise<UploadTicket> => ({
        mediaId: mediaId(9),
        uploadUrl: "https://bucket.test/put",
        contentType: "image/png",
        expiresInSeconds: 300,
      })),
      confirmUpload: vi.fn(async (_c, id): Promise<MediaView> => ({
        id,
        contentType: "image/png",
        sizeBytes: 4096,
        status: "ready",
        url: `/api/v1/public/media/${id}`,
      })),
      deleteMedia: vi.fn(async (_c, id) => {
        deleted.push(id);
      }),
      getMedia: vi.fn(async (_c, id) => byId.get(id) ?? null),
      listMediaFor: vi.fn(async () => [...byId.values()].filter((m) => m.status === "ready")),
      ...over,
    },
  };
}

describe("requestFormImageUpload", () => {
  it("refuses before minting a URL once the carousel is full", async () => {
    const full = seedForm({
      carousel: [1, 2, 3].map((n) => ({ mediaId: new ObjectId(mediaId(n)), alt: "" })),
    });
    const d = deps(full, []);

    await expect(
      requestFormImageUpload(ctx, FORM_ID, { contentType: "image/png", sizeBytes: 10 }, d.deps),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(d.deps.requestUpload).not.toHaveBeenCalled();
  });

  it("mints a ticket while there is room", async () => {
    const d = deps(seedForm(), []);
    const ticket = await requestFormImageUpload(
      ctx,
      FORM_ID,
      { contentType: "image/png", sizeBytes: 10 },
      d.deps,
    );
    expect(ticket.uploadUrl).toBe("https://bucket.test/put");
  });
});

describe("attachFormImage", () => {
  it("confirms the upload and appends the slide", async () => {
    const media = seedMedia(mediaId(1), { status: "pending", sizeBytes: 0 });
    const d = deps(seedForm(), [media]);

    const carousel = await attachFormImage(ctx, FORM_ID, mediaId(1), "A boat", d.deps);

    expect(d.deps.confirmUpload).toHaveBeenCalledWith(ctx, mediaId(1));
    expect(carousel).toEqual([
      { mediaId: mediaId(1), alt: "A boat", url: `/api/v1/public/media/${mediaId(1)}` },
    ]);
  });

  it("refuses media that belongs to another form of the same tenant", async () => {
    const foreign = seedMedia(mediaId(1), { ownerId: new ObjectId(OTHER_FORM_ID) });
    const d = deps(seedForm(), [foreign]);

    await expect(attachFormImage(ctx, FORM_ID, mediaId(1), "", d.deps)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(d.deps.confirmUpload).not.toHaveBeenCalled();
  });

  it("is idempotent for a slide already on the carousel", async () => {
    const form = seedForm({ carousel: [{ mediaId: new ObjectId(mediaId(1)), alt: "A boat" }] });
    const d = deps(form, [seedMedia(mediaId(1))]);

    const carousel = await attachFormImage(ctx, FORM_ID, mediaId(1), "ignored", d.deps);

    expect(carousel).toHaveLength(1);
    expect(carousel[0].alt).toBe("A boat");
    expect(d.deps.confirmUpload).not.toHaveBeenCalled();
  });

  it("deletes the object it just charged for when the append loses the race", async () => {
    const form = seedForm({
      carousel: [1, 2, 3].map((n) => ({ mediaId: new ObjectId(mediaId(n)), alt: "" })),
    });
    // Past the up-front check because the media row exists and is unattached;
    // only the guarded write can catch this.
    const d = deps(form, [seedMedia(mediaId(4), { status: "pending" })]);

    await expect(attachFormImage(ctx, FORM_ID, mediaId(4), "", d.deps)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(d.deleted).toEqual([mediaId(4)]);
  });
});

describe("updateFormCarousel", () => {
  it("reorders and rewrites alt text without deleting anything", async () => {
    const form = seedForm({
      carousel: [
        { mediaId: new ObjectId(mediaId(1)), alt: "one" },
        { mediaId: new ObjectId(mediaId(2)), alt: "two" },
      ],
    });
    const d = deps(form, [seedMedia(mediaId(1)), seedMedia(mediaId(2))]);

    const carousel = await updateFormCarousel(
      ctx,
      FORM_ID,
      {
        images: [
          { mediaId: mediaId(2), alt: "second, now first" },
          { mediaId: mediaId(1), alt: "one" },
        ],
      },
      d.deps,
    );

    expect(carousel.map((c) => c.mediaId)).toEqual([mediaId(2), mediaId(1)]);
    expect(carousel[0].alt).toBe("second, now first");
    expect(d.deleted).toEqual([]);
  });

  it("deletes the object of an image dropped from the array", async () => {
    const form = seedForm({
      carousel: [
        { mediaId: new ObjectId(mediaId(1)), alt: "one" },
        { mediaId: new ObjectId(mediaId(2)), alt: "two" },
      ],
    });
    const d = deps(form, [seedMedia(mediaId(1)), seedMedia(mediaId(2))]);

    await updateFormCarousel(
      ctx,
      FORM_ID,
      { images: [{ mediaId: mediaId(1), alt: "one" }] },
      d.deps,
    );

    expect(d.deleted).toEqual([mediaId(2)]);
  });

  it("refuses an id that is not this form's media", async () => {
    const d = deps(seedForm(), [seedMedia(mediaId(1))]);

    await expect(
      updateFormCarousel(ctx, FORM_ID, { images: [{ mediaId: mediaId(7), alt: "" }] }, d.deps),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("refuses the same image twice", async () => {
    const d = deps(seedForm(), [seedMedia(mediaId(1))]);

    await expect(
      updateFormCarousel(
        ctx,
        FORM_ID,
        {
          images: [
            { mediaId: mediaId(1), alt: "" },
            { mediaId: mediaId(1), alt: "" },
          ],
        },
        d.deps,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("refuses more than three images", async () => {
    const d = deps(
      seedForm(),
      [1, 2, 3, 4].map((n) => seedMedia(mediaId(n))),
    );

    await expect(
      updateFormCarousel(
        ctx,
        FORM_ID,
        { images: [1, 2, 3, 4].map((n) => ({ mediaId: mediaId(n), alt: "" })) },
        d.deps,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("removeFormImage", () => {
  it("detaches the slide and deletes its object", async () => {
    const form = seedForm({
      carousel: [
        { mediaId: new ObjectId(mediaId(1)), alt: "one" },
        { mediaId: new ObjectId(mediaId(2)), alt: "two" },
      ],
    });
    const d = deps(form, [seedMedia(mediaId(1)), seedMedia(mediaId(2))]);

    const carousel = await removeFormImage(ctx, FORM_ID, mediaId(1), d.deps);

    expect(carousel.map((c) => c.mediaId)).toEqual([mediaId(2)]);
    expect(d.deleted).toEqual([mediaId(1)]);
  });

  it("404s for an image that is not on this carousel", async () => {
    const d = deps(seedForm(), []);
    await expect(removeFormImage(ctx, FORM_ID, mediaId(1), d.deps)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

/**
 * The public read path is an *authorization* boundary, not a lookup: an image
 * is served only while the form that owns it is published and enabled. Every
 * way that can go wrong is a way a private photo becomes public, so each one
 * is asserted separately.
 */
describe("findServablePublicMedia", () => {
  const live = (over: Partial<WithId<FormDoc>> = {}) =>
    seedForm({
      published: true,
      enabled: true,
      carousel: [{ mediaId: new ObjectId(mediaId(1)), alt: "A boat" }],
      ...over,
    });

  const publicDeps = (
    media: WithId<MediaDoc> | null,
    form: WithId<FormDoc> | null,
  ): Partial<PublicMediaDeps> => ({
    findReadyMedia: async () => media,
    findOwningForm: async () => form,
  });

  it("serves an attached image on a published, enabled form", async () => {
    const media = seedMedia(mediaId(1));
    const found = await findServablePublicMedia(mediaId(1), publicDeps(media, live()));
    expect(found).toEqual({ key: media.key, contentType: "image/png" });
  });

  it("serves nothing for an unknown or unready id", async () => {
    expect(await findServablePublicMedia(mediaId(1), publicDeps(null, live()))).toBeNull();
  });

  it("goes dark when the form is unpublished", async () => {
    const found = await findServablePublicMedia(
      mediaId(1),
      publicDeps(seedMedia(mediaId(1)), live({ published: false })),
    );
    expect(found).toBeNull();
  });

  it("goes dark when the kill switch is thrown", async () => {
    const found = await findServablePublicMedia(
      mediaId(1),
      publicDeps(seedMedia(mediaId(1)), live({ enabled: false })),
    );
    expect(found).toBeNull();
  });

  it("goes dark when the form is gone", async () => {
    const found = await findServablePublicMedia(
      mediaId(1),
      publicDeps(seedMedia(mediaId(1)), null),
    );
    expect(found).toBeNull();
  });

  it("refuses an image detached from the carousel, even before its object is swept", async () => {
    const found = await findServablePublicMedia(
      mediaId(1),
      publicDeps(seedMedia(mediaId(1)), live({ carousel: [] })),
    );
    expect(found).toBeNull();
  });

  it("refuses media owned by something that is not a form", async () => {
    const found = await findServablePublicMedia(
      mediaId(1),
      publicDeps(seedMedia(mediaId(1), { ownerType: "video" as never }), live()),
    );
    expect(found).toBeNull();
  });

  it("looks the form up under the media's own tenant, not a caller-supplied one", async () => {
    const media = seedMedia(mediaId(1));
    const findOwningForm = vi.fn(async () => live());

    await findServablePublicMedia(mediaId(1), {
      findReadyMedia: async () => media,
      findOwningForm,
    });

    expect(findOwningForm).toHaveBeenCalledWith(media.ownerId, media.tenantId);
  });
});
