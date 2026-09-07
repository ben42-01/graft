/**
 * Media uploads — unit coverage.
 *
 * The two-step upload is the thing worth pinning: everything that can go wrong
 * happens *between* the presign and the confirm, where the app is not looking.
 * The object store and the storage meter are fake ports, so the size check,
 * the quota charge, the ordering between them and the cleanup on refusal are
 * exercised as pure logic. Persistence and cross-tenant scoping are proven for
 * real by bruno/forms/carousel-*.bru.
 */
import { ObjectId, type WithId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import type { Repository } from "@/server/repositories/base";
import type { ObjectStore } from "@/server/storage/s3";
import type { QuotaResult } from "@/server/services/meters";
import {
  ALLOWED_IMAGE_TYPES,
  confirmUpload,
  deleteMedia,
  MAX_IMAGE_BYTES,
  mediaUrl,
  megabytesFor,
  requestUpload,
  requestUploadSchema,
  type MediaDoc,
} from "./media";

const TENANT = "000000000000000000000001";
const USER = "00000000000000000000000b";
const FORM_ID = "000000000000000000000031";

const ctx: Ctx = createContext({
  requestId: "req-media",
  tenantId: TENANT,
  userId: USER,
  roles: ["owner"],
  tier: "free",
});

const allowedQuota: QuotaResult = {
  meter: "storage_mb",
  period: "all",
  allowed: true,
  limit: 250,
  used: 1,
  remaining: 249,
  warned: false,
};

function fakeStore(over: Partial<ObjectStore> = {}): ObjectStore {
  return {
    presignPut: vi.fn(async (key: string) => `https://bucket.test/${key}?sig=put`),
    presignGet: vi.fn(async (key: string) => `https://bucket.test/${key}?sig=get`),
    head: vi.fn(async () => ({ sizeBytes: 1024, contentType: "image/png" })),
    remove: vi.fn(async () => {}),
    ...over,
  };
}

/** A minimal in-memory stand-in for the repository port (base.ts). */
function fakeRepo(seed: WithId<MediaDoc>[] = []) {
  const docs = new Map(seed.map((d) => [d._id.toHexString(), d]));
  const tenantId = new ObjectId(TENANT);

  const repo: Repository<MediaDoc> = {
    collectionName: "media",
    collection: vi.fn() as unknown as Repository<MediaDoc>["collection"],

    async find(_ctx, filter) {
      const f = (filter ?? {}) as Record<string, unknown>;
      return [...docs.values()].filter(
        (d) =>
          d.tenantId.equals(tenantId) &&
          !d.deletedAt &&
          (f.status === undefined || d.status === f.status) &&
          (f.ownerId === undefined || d.ownerId.equals(f.ownerId as ObjectId)),
      );
    },

    async findOne() {
      return null;
    },

    async findById(_ctx, id) {
      const found = docs.get(id.toString());
      return found && found.tenantId.equals(tenantId) && !found.deletedAt ? found : null;
    },

    async count() {
      return docs.size;
    },

    async insertOne(_ctx, doc) {
      const withId = {
        ...doc,
        tenantId,
        createdAt: new Date(),
        updatedAt: new Date(),
        _id: new ObjectId(),
      } as unknown as WithId<MediaDoc>;
      docs.set(withId._id.toHexString(), withId);
      return withId;
    },

    async updateOne(_ctx, filter, update) {
      const f = filter as Record<string, unknown>;
      const target = [...docs.values()].find(
        (d) =>
          d._id.equals(f._id as ObjectId) && (f.status === undefined || d.status === f.status),
      );
      if (!target) return null;
      const updated = { ...target, ...(update.$set ?? {}) } as WithId<MediaDoc>;
      docs.set(updated._id.toHexString(), updated);
      return updated;
    },

    async softDelete(_ctx, id) {
      const target = docs.get(id.toString());
      if (!target) return false;
      docs.set(id.toString(), { ...target, deletedAt: new Date() });
      return true;
    },

    async listPage() {
      return { items: [...docs.values()], meta: { limit: 25, hasMore: false, cursor: null } };
    },
  };
  return { repo, docs };
}

const seedMedia = (over: Partial<WithId<MediaDoc>> = {}): WithId<MediaDoc> => ({
  _id: new ObjectId(),
  tenantId: new ObjectId(TENANT),
  key: `tenants/${TENANT}/forms/${FORM_ID}/abc.png`,
  contentType: "image/png",
  sizeBytes: 0,
  status: "pending",
  ownerType: "form",
  ownerId: new ObjectId(FORM_ID),
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

describe("megabytesFor", () => {
  it("rounds up, and never bills zero for a real file", () => {
    expect(megabytesFor(1)).toBe(1);
    expect(megabytesFor(1024 * 1024)).toBe(1);
    expect(megabytesFor(1024 * 1024 + 1)).toBe(2);
    expect(megabytesFor(5 * 1024 * 1024)).toBe(5);
  });
});

describe("requestUploadSchema", () => {
  it("accepts every allowed raster type", () => {
    for (const contentType of ALLOWED_IMAGE_TYPES) {
      expect(requestUploadSchema.safeParse({ contentType, sizeBytes: 10 }).success).toBe(true);
    }
  });

  it("refuses SVG — it is a script host, not a photo", () => {
    const result = requestUploadSchema.safeParse({
      contentType: "image/svg+xml",
      sizeBytes: 10,
    });
    expect(result.success).toBe(false);
  });

  it("refuses a declaration above the ceiling before any URL is minted", () => {
    expect(
      requestUploadSchema.safeParse({
        contentType: "image/png",
        sizeBytes: MAX_IMAGE_BYTES + 1,
      }).success,
    ).toBe(false);
  });
});

describe("requestUpload", () => {
  it("namespaces the key by tenant and owner, and never trusts a client key", async () => {
    const { repo, docs } = fakeRepo();
    const store = fakeStore();

    const ticket = await requestUpload(
      ctx,
      { type: "form", id: FORM_ID },
      { contentType: "image/webp", sizeBytes: 2048 },
      { repo, store, consumeQuota: async () => allowedQuota, randomKey: () => "fixed" },
    );

    const doc = [...docs.values()][0];
    expect(doc.key).toBe(`tenants/${TENANT}/forms/${FORM_ID}/fixed.webp`);
    expect(doc.status).toBe("pending");
    expect(ticket.uploadUrl).toContain(doc.key);
    expect(ticket.contentType).toBe("image/webp");
  });

  it("charges nothing — an upload that never happens must not cost storage", async () => {
    const { repo } = fakeRepo();
    const consumeQuota = vi.fn(async () => allowedQuota);

    await requestUpload(
      ctx,
      { type: "form", id: FORM_ID },
      { contentType: "image/png", sizeBytes: 2048 },
      { repo, store: fakeStore(), consumeQuota, randomKey: () => "fixed" },
    );

    expect(consumeQuota).not.toHaveBeenCalled();
  });
});

describe("confirmUpload", () => {
  it("charges the bucket's size, not the browser's claim", async () => {
    const doc = seedMedia();
    const { repo } = fakeRepo([doc]);
    const consumeQuota = vi.fn(async () => allowedQuota);
    const store = fakeStore({
      head: async () => ({ sizeBytes: 2.5 * 1024 * 1024, contentType: "image/png" }),
    });

    const view = await confirmUpload(ctx, doc._id.toHexString(), {
      repo,
      store,
      consumeQuota,
      randomKey: () => "fixed",
    });

    expect(consumeQuota).toHaveBeenCalledWith(ctx, 3);
    expect(view.status).toBe("ready");
    expect(view.sizeBytes).toBe(2.5 * 1024 * 1024);
    expect(view.url).toBe(mediaUrl(doc._id.toHexString()));
  });

  it("refuses and deletes an object that overran the cap after signing", async () => {
    const doc = seedMedia();
    const { repo, docs } = fakeRepo([doc]);
    const consumeQuota = vi.fn(async () => allowedQuota);
    const store = fakeStore({
      head: async () => ({ sizeBytes: MAX_IMAGE_BYTES + 1, contentType: "image/png" }),
    });

    await expect(
      confirmUpload(ctx, doc._id.toHexString(), {
        repo,
        store,
        consumeQuota,
        randomKey: () => "fixed",
      }),
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });

    expect(store.remove).toHaveBeenCalledWith(doc.key);
    expect(docs.get(doc._id.toHexString())?.deletedAt).toBeInstanceOf(Date);
    expect(consumeQuota).not.toHaveBeenCalled();
  });

  it("refuses when nothing was ever uploaded to the signed URL", async () => {
    const doc = seedMedia();
    const { repo } = fakeRepo([doc]);

    await expect(
      confirmUpload(ctx, doc._id.toHexString(), {
        repo,
        store: fakeStore({ head: async () => null }),
        consumeQuota: async () => allowedQuota,
        randomKey: () => "fixed",
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("leaves the row pending when quota refuses, so nothing can serve it", async () => {
    const doc = seedMedia();
    const { repo, docs } = fakeRepo([doc]);

    await expect(
      confirmUpload(ctx, doc._id.toHexString(), {
        repo,
        store: fakeStore(),
        consumeQuota: async () => {
          throw new AppError("QUOTA_EXCEEDED", "out of storage");
        },
        randomKey: () => "fixed",
      }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });

    expect(docs.get(doc._id.toHexString())?.status).toBe("pending");
  });

  it("is idempotent — a retried confirm does not charge twice", async () => {
    const doc = seedMedia({ status: "ready", sizeBytes: 4096 });
    const { repo } = fakeRepo([doc]);
    const consumeQuota = vi.fn(async () => allowedQuota);

    const view = await confirmUpload(ctx, doc._id.toHexString(), {
      repo,
      store: fakeStore(),
      consumeQuota,
      randomKey: () => "fixed",
    });

    expect(view.status).toBe("ready");
    expect(consumeQuota).not.toHaveBeenCalled();
  });

  it("cannot confirm another tenant's upload — it is simply not found", async () => {
    const doc = seedMedia({ tenantId: new ObjectId("0000000000000000000000ff") });
    const { repo } = fakeRepo([doc]);

    await expect(
      confirmUpload(ctx, doc._id.toHexString(), {
        repo,
        store: fakeStore(),
        consumeQuota: async () => allowedQuota,
        randomKey: () => "fixed",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("deleteMedia", () => {
  it("removes the object before the row, so no storage is left unreferenced", async () => {
    const doc = seedMedia({ status: "ready", sizeBytes: 4096 });
    const { repo, docs } = fakeRepo([doc]);
    const store = fakeStore();

    await deleteMedia(ctx, doc._id.toHexString(), {
      repo,
      store,
      consumeQuota: async () => allowedQuota,
      randomKey: () => "fixed",
    });

    expect(store.remove).toHaveBeenCalledWith(doc.key);
    expect(docs.get(doc._id.toHexString())?.deletedAt).toBeInstanceOf(Date);
  });
});
