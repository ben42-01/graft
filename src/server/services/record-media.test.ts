/**
 * Record images — unit coverage.
 *
 * The invariants worth pinning span three modules and so cannot be enforced
 * by any of them alone: the field must be declared `image` on the entity, the
 * media must belong to *this* record, the field holds exactly one image, and
 * replacing one must never leave the record pointing at an object that has
 * already been deleted.
 */
import { ObjectId, type WithId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import type { Repository } from "@/server/repositories/base";
import type { EntityView, FieldDef } from "./entities";
import type { MediaDoc, MediaView, UploadTicket } from "./media";
import type { RecordDoc } from "./records";
import {
  attachRecordImage,
  removeRecordImage,
  requestRecordImageUpload,
  type RecordMediaDeps,
} from "./record-media";

const TENANT = "000000000000000000000001";
const USER = "00000000000000000000000b";
const ENTITY_ID = "000000000000000000000021";
const OTHER_ENTITY = "000000000000000000000022";
const RECORD_ID = "000000000000000000000041";
const OTHER_RECORD = "000000000000000000000042";

const ctx: Ctx = createContext({
  requestId: "req-record-media",
  tenantId: TENANT,
  userId: USER,
  roles: ["owner"],
  tier: "free",
});

const mediaId = (n: number) => `0000000000000000000000${n.toString().padStart(2, "0")}`;

const fields: FieldDef[] = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "photo", label: "Photo", type: "image", required: false },
];

const entity: EntityView = {
  id: ENTITY_ID,
  key: "rental_items",
  name: "Rental Items",
  fields,
  schemaVersion: 1,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const seedRecord = (data: Record<string, unknown> = {}): WithId<RecordDoc> => ({
  _id: new ObjectId(RECORD_ID),
  tenantId: new ObjectId(TENANT),
  entityDefId: new ObjectId(ENTITY_ID),
  schemaVersion: 1,
  data: { name: "Pontoon", ...data },
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

const seedMedia = (id: string, over: Partial<WithId<MediaDoc>> = {}): WithId<MediaDoc> => ({
  _id: new ObjectId(id),
  tenantId: new ObjectId(TENANT),
  key: `tenants/${TENANT}/records/${RECORD_ID}/${id}.png`,
  contentType: "image/png",
  sizeBytes: 4096,
  status: "ready",
  ownerType: "record",
  ownerId: new ObjectId(RECORD_ID),
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

function fakeRecordsRepo(seed: WithId<RecordDoc> | null) {
  let doc = seed;
  const repo: Repository<RecordDoc> = {
    collectionName: "records",
    collection: vi.fn() as unknown as Repository<RecordDoc>["collection"],
    async find() {
      return doc ? [doc] : [];
    },
    async findOne() {
      return doc;
    },
    async findById(_c, id) {
      return doc && id.toString() === doc._id.toHexString() ? doc : null;
    },
    async count() {
      return doc ? 1 : 0;
    },
    async insertOne() {
      throw new Error("not used");
    },
    async updateOne(_c, _filter, update) {
      if (!doc) return null;
      const set = (update as Record<string, Record<string, unknown>>).$set;
      const unset = (update as Record<string, Record<string, unknown>>).$unset;
      const data = { ...doc.data };
      for (const [path, value] of Object.entries(set ?? {})) {
        data[path.replace(/^data\./, "")] = value;
      }
      for (const path of Object.keys(unset ?? {})) delete data[path.replace(/^data\./, "")];
      doc = { ...doc, data };
      return doc;
    },
    async softDelete() {
      return true;
    },
    async listPage() {
      return { items: doc ? [doc] : [], meta: { limit: 25, hasMore: false, cursor: null } };
    },
  };
  return { repo, current: () => doc };
}

function deps(
  record: WithId<RecordDoc> | null,
  media: WithId<MediaDoc>[],
  over: Partial<RecordMediaDeps> = {},
) {
  const records = fakeRecordsRepo(record);
  const deleted: string[] = [];
  const byId = new Map(media.map((m) => [m._id.toHexString(), m]));

  return {
    records,
    deleted,
    deps: {
      records: records.repo,
      getEntity: vi.fn(async () => entity),
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
      ...over,
    } satisfies Partial<RecordMediaDeps>,
  };
}

describe("requestRecordImageUpload", () => {
  it("mints a ticket owned by the record, not by the entity", async () => {
    const d = deps(seedRecord(), []);

    await requestRecordImageUpload(
      ctx,
      ENTITY_ID,
      RECORD_ID,
      "photo",
      { contentType: "image/png", sizeBytes: 10 },
      d.deps,
    );

    expect(d.deps.requestUpload).toHaveBeenCalledWith(
      ctx,
      { type: "record", id: RECORD_ID },
      { contentType: "image/png", sizeBytes: 10 },
    );
  });

  it("refuses a field that is not an image, before minting anything", async () => {
    const d = deps(seedRecord(), []);

    await expect(
      requestRecordImageUpload(
        ctx,
        ENTITY_ID,
        RECORD_ID,
        "name",
        { contentType: "image/png", sizeBytes: 10 },
        d.deps,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(d.deps.requestUpload).not.toHaveBeenCalled();
  });

  it("refuses a field the entity does not have", async () => {
    const d = deps(seedRecord(), []);
    await expect(
      requestRecordImageUpload(
        ctx,
        ENTITY_ID,
        RECORD_ID,
        "nonexistent",
        { contentType: "image/png", sizeBytes: 10 },
        d.deps,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("404s a record that belongs to a different entity of the same tenant", async () => {
    const foreign = { ...seedRecord(), entityDefId: new ObjectId(OTHER_ENTITY) };
    const d = deps(foreign, []);

    await expect(
      requestRecordImageUpload(
        ctx,
        ENTITY_ID,
        RECORD_ID,
        "photo",
        { contentType: "image/png", sizeBytes: 10 },
        d.deps,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("attachRecordImage", () => {
  it("confirms the upload and points the field at it", async () => {
    const d = deps(seedRecord(), [seedMedia(mediaId(1), { status: "pending" })]);

    const result = await attachRecordImage(
      ctx,
      ENTITY_ID,
      RECORD_ID,
      "photo",
      mediaId(1),
      d.deps,
    );

    expect(d.deps.confirmUpload).toHaveBeenCalledWith(ctx, mediaId(1));
    expect(result).toEqual({
      mediaId: mediaId(1),
      url: `/api/v1/public/media/${mediaId(1)}`,
    });
    expect(d.records.current()!.data.photo).toBe(mediaId(1));
  });

  it("replaces the previous image and deletes only the old object", async () => {
    const d = deps(seedRecord({ photo: mediaId(1) }), [
      seedMedia(mediaId(1)),
      seedMedia(mediaId(2), { status: "pending" }),
    ]);

    await attachRecordImage(ctx, ENTITY_ID, RECORD_ID, "photo", mediaId(2), d.deps);

    expect(d.records.current()!.data.photo).toBe(mediaId(2));
    expect(d.deleted).toEqual([mediaId(1)]);
  });

  it("is idempotent for an image already in the field", async () => {
    const d = deps(seedRecord({ photo: mediaId(1) }), [seedMedia(mediaId(1))]);

    await attachRecordImage(ctx, ENTITY_ID, RECORD_ID, "photo", mediaId(1), d.deps);

    expect(d.deps.confirmUpload).not.toHaveBeenCalled();
    expect(d.deleted).toEqual([]);
  });

  it("refuses media that belongs to another record of the same tenant", async () => {
    const foreign = seedMedia(mediaId(1), { ownerId: new ObjectId(OTHER_RECORD) });
    const d = deps(seedRecord(), [foreign]);

    await expect(
      attachRecordImage(ctx, ENTITY_ID, RECORD_ID, "photo", mediaId(1), d.deps),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(d.deps.confirmUpload).not.toHaveBeenCalled();
  });

  it("refuses a form's carousel image quoted at a record", async () => {
    const carouselImage = seedMedia(mediaId(1), { ownerType: "form" });
    const d = deps(seedRecord(), [carouselImage]);

    await expect(
      attachRecordImage(ctx, ENTITY_ID, RECORD_ID, "photo", mediaId(1), d.deps),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("deletes the object it just charged for when the record vanished", async () => {
    const d = deps(seedRecord(), [seedMedia(mediaId(1), { status: "pending" })], {});
    // The record is read successfully, then disappears before the write.
    d.deps.records!.updateOne = vi.fn(
      async () => null,
    ) as unknown as Repository<RecordDoc>["updateOne"];

    await expect(
      attachRecordImage(ctx, ENTITY_ID, RECORD_ID, "photo", mediaId(1), d.deps),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(d.deleted).toEqual([mediaId(1)]);
  });
});

describe("removeRecordImage", () => {
  it("clears the field and deletes the object", async () => {
    const d = deps(seedRecord({ photo: mediaId(1) }), [seedMedia(mediaId(1))]);

    await removeRecordImage(ctx, ENTITY_ID, RECORD_ID, "photo", d.deps);

    expect(d.records.current()!.data.photo).toBeUndefined();
    expect(d.deleted).toEqual([mediaId(1)]);
  });

  it("404s a field that has no image", async () => {
    const d = deps(seedRecord(), []);
    await expect(
      removeRecordImage(ctx, ENTITY_ID, RECORD_ID, "photo", d.deps),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
