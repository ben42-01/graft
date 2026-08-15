/**
 * The repository layer — the other half of the tenant isolation boundary
 * (docs/BACKEND.md §1.2, §6).
 *
 * PROTECTED PATH (.github/agent-policy.yml). Every rule here exists so that
 * isolation cannot be forgotten rather than merely required:
 *
 *   1. Every method takes `ctx` first, and TypeScript will not let you omit it.
 *   2. `tenantId` is injected from `ctx`, always, as the last word on the filter.
 *   3. A caller who writes `tenantId` themselves is rejected, not overruled —
 *      silently winning that argument would hide the bug that wrote it.
 *
 * Services never touch a collection directly; if a query is not expressible
 * here, the repository grows a method rather than the caller reaching past it.
 */
import { ObjectId } from "mongodb";
import type {
  Collection,
  Document,
  Filter,
  FindOptions,
  OptionalUnlessRequiredId,
  UpdateFilter,
  WithId,
} from "mongodb";
import type { Ctx } from "@/server/context";
import { getDb } from "@/server/db/mongo";
import { clampLimit, decodeCursor, page, type PageMeta } from "@/server/http/pagination";

/** Raised when a caller tries to supply the one field it may never supply. */
export class TenantScopeError extends Error {
  constructor(what: string) {
    super(
      `A ${what} may not carry tenantId — scoping is injected from ctx by the repository layer.`,
    );
    this.name = "TenantScopeError";
  }
}

/** What a caller may hand to `insertOne`: the document minus what we stamp. */
export type TenantDoc<T> = Omit<T, "tenantId" | "createdAt" | "updatedAt">;

/**
 * Cursor paging is over `_id` descending. A caller-chosen sort would need a
 * compound cursor to stay stable, so it is deliberately not an option here —
 * the constrained sort grammar arrives with records (docs/BACKEND.md §2).
 */
export type ListPageOptions<T extends Document> = {
  filter?: Filter<T>;
  limit?: unknown;
  cursor?: string;
};

export type Repository<T extends Document> = {
  readonly collectionName: string;
  collection(): Promise<Collection<T>>;
  find(ctx: Ctx, filter?: Filter<T>, options?: FindOptions): Promise<WithId<T>[]>;
  findOne(ctx: Ctx, filter?: Filter<T>, options?: FindOptions): Promise<WithId<T> | null>;
  findById(ctx: Ctx, id: string | ObjectId): Promise<WithId<T> | null>;
  count(ctx: Ctx, filter?: Filter<T>): Promise<number>;
  insertOne(ctx: Ctx, doc: TenantDoc<T>): Promise<WithId<T>>;
  updateOne(ctx: Ctx, filter: Filter<T>, update: UpdateFilter<T>): Promise<WithId<T> | null>;
  softDelete(ctx: Ctx, id: string | ObjectId): Promise<boolean>;
  listPage(
    ctx: Ctx,
    options?: ListPageOptions<T>,
  ): Promise<{ items: WithId<T>[]; meta: PageMeta }>;
};

const MAX_GUARD_DEPTH = 8;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Walks a filter, update or document looking for a caller-written `tenantId`,
 * including one buried in `$or`/`$and`/`$set`. Only plain objects and arrays are
 * followed — an ObjectId or Date has nothing to hide.
 */
export function assertNoTenantId(value: unknown, what: string, depth = 0): void {
  if (depth > MAX_GUARD_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoTenantId(item, what, depth + 1);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "tenantId" || key.endsWith(".tenantId")) throw new TenantScopeError(what);
    assertNoTenantId(item, what, depth + 1);
  }
}

function toObjectId(id: string | ObjectId, what: string): ObjectId {
  if (id instanceof ObjectId) return id;
  if (!ObjectId.isValid(id)) throw new TenantScopeError(what);
  return new ObjectId(id);
}

export function createRepository<T extends Document>(collectionName: string): Repository<T> {
  const collection = async (): Promise<Collection<T>> =>
    (await getDb()).collection<T>(collectionName);

  const tenantId = (ctx: Ctx) => toObjectId(ctx.tenantId, "context");

  /**
   * The only way a filter reaches Mongo. `deletedAt: null` first so a caller can
   * opt into deleted rows; `tenantId` last so nobody can opt out of the tenant.
   * (Mongo treats `{ deletedAt: null }` as "null or absent", so collections
   * without soft deletes are unaffected.)
   */
  const scoped = (ctx: Ctx, filter: Filter<T> = {}): Filter<T> => {
    assertNoTenantId(filter, "filter");
    // The cast is unavoidable for a generic T: the object below is a valid
    // Filter<T> by construction, but TypeScript cannot see through the spread.
    return { deletedAt: null, ...filter, tenantId: tenantId(ctx) } as Filter<T>;
  };

  const findOne = async (
    ctx: Ctx,
    filter?: Filter<T>,
    options?: FindOptions,
  ): Promise<WithId<T> | null> => {
    const col = await collection();
    return col.findOne(scoped(ctx, filter), options);
  };

  return {
    collectionName,
    collection,
    findOne,

    async find(ctx, filter, options) {
      const col = await collection();
      return col.find(scoped(ctx, filter), options).toArray();
    },

    async findById(ctx, id) {
      return findOne(ctx, { _id: toObjectId(id, "id") } as Filter<T>);
    },

    async count(ctx, filter) {
      const col = await collection();
      return col.countDocuments(scoped(ctx, filter));
    },

    async insertOne(ctx, doc) {
      assertNoTenantId(doc, "document");
      const col = await collection();
      const now = new Date();
      // Double cast: `TenantDoc<T>` plus the fields stamped here *is* a T, but
      // TypeScript cannot recompose a generic from an Omit and a spread.
      const full = {
        ...doc,
        tenantId: tenantId(ctx),
        createdAt: now,
        updatedAt: now,
      } as unknown as OptionalUnlessRequiredId<T>;
      const { insertedId } = await col.insertOne(full);
      return { ...full, _id: insertedId } as WithId<T>;
    },

    async updateOne(ctx, filter, update) {
      // Guarding the update as well as the filter: `$set: { tenantId }` would
      // otherwise hand a document to another tenant.
      assertNoTenantId(update, "update");
      const col = await collection();
      // Double cast: `updatedAt` is not provably a key of an unresolved generic T.
      const stamped = {
        ...update,
        $set: { ...(update.$set ?? {}), updatedAt: new Date() },
      } as unknown as UpdateFilter<T>;
      return col.findOneAndUpdate(scoped(ctx, filter), stamped, { returnDocument: "after" });
    },

    async softDelete(ctx, id) {
      const col = await collection();
      const now = new Date();
      const result = await col.updateOne(
        scoped(ctx, { _id: toObjectId(id, "id") } as Filter<T>),
        // Double cast: soft-delete fields are not provably keys of a generic T.
        { $set: { deletedAt: now, updatedAt: now } } as unknown as UpdateFilter<T>,
      );
      return result.matchedCount > 0;
    },

    async listPage(ctx, options = {}) {
      const limit = clampLimit(options.limit);
      const base = scoped(ctx, options.filter);
      // $and rather than a merge: a caller filter on _id must survive paging.
      const filter = options.cursor
        ? ({
            $and: [base, { _id: { $lt: new ObjectId(decodeCursor(options.cursor).id) } }],
          } as Filter<T>)
        : base;
      const col = await collection();
      const rows = await col
        .find(filter)
        .sort({ _id: -1 })
        // One extra row is how hasMore is known without a second query.
        .limit(limit + 1)
        .toArray();
      return page(rows, limit, (row) => ({ id: row._id.toString() }));
    },
  };
}
