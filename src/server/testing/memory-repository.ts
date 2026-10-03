/**
 * An in-memory `Repository` for unit tests of read-side services — the ones
 * whose whole job is joining collections, where a stub that ignores its filter
 * would prove nothing.
 *
 * It evaluates the small slice of Mongo's filter language those services
 * actually use (equality, `$in`, `$ne`, `$gte`, `$lt`, `$or`) and, like the
 * real repository, only ever returns the calling tenant's live rows. It is
 * deliberately not a Mongo emulator: an operator it does not know throws, so
 * a test can never pass against a filter that was silently ignored.
 */
import { ObjectId, type Document, type WithId } from "mongodb";
import type { Ctx } from "@/server/context";
import type { Repository } from "@/server/repositories/base";

const same = (a: unknown, b: unknown): boolean => {
  if (a instanceof ObjectId && b instanceof ObjectId) return a.equals(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
};

const order = (value: unknown): number | string =>
  value instanceof Date ? value.getTime() : (value as number | string);

function matchesCondition(value: unknown, condition: unknown): boolean {
  const isOperatorObject =
    typeof condition === "object" &&
    condition !== null &&
    !(condition instanceof ObjectId) &&
    !(condition instanceof Date);
  if (!isOperatorObject) return same(value ?? null, condition ?? null);

  return Object.entries(condition as Record<string, unknown>).every(([op, operand]) => {
    switch (op) {
      case "$in":
        return (operand as unknown[]).some((candidate) => same(value, candidate));
      case "$ne":
        return !same(value ?? null, operand ?? null);
      case "$gte":
        return value != null && order(value) >= order(operand);
      case "$lt":
        return value != null && order(value) < order(operand);
      default:
        throw new Error(`memoryRepository does not implement ${op}`);
    }
  });
}

export function matches(row: Document, filter: Record<string, unknown> = {}): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$or") {
      return (condition as Record<string, unknown>[]).some((arm) => matches(row, arm));
    }
    if (key.startsWith("$")) throw new Error(`memoryRepository does not implement ${key}`);
    return matchesCondition(row[key], condition);
  });
}

export function memoryRepository<T extends Document>(
  collectionName: string,
  rows: WithId<T>[],
): Repository<T> {
  const visible = (ctx: Ctx, filter?: unknown) =>
    rows
      .filter(
        (row) =>
          (row.tenantId as ObjectId).toHexString() === ctx.tenantId &&
          !row.deletedAt &&
          matches(row, filter as Record<string, unknown> | undefined),
      )
      // Newest first, which is what every caller of these reads asks for.
      .sort((a, b) => b._id.toString().localeCompare(a._id.toString()));

  const unsupported = () => {
    throw new Error("memoryRepository is read-only");
  };

  return {
    collectionName,
    collection: unsupported,
    async find(ctx, filter, options) {
      const found = visible(ctx, filter);
      return options?.limit ? found.slice(0, options.limit) : found;
    },
    async findOne(ctx, filter) {
      return visible(ctx, filter)[0] ?? null;
    },
    async findById(ctx, id) {
      return visible(ctx, { _id: new ObjectId(id) })[0] ?? null;
    },
    async count(ctx, filter) {
      return visible(ctx, filter).length;
    },
    insertOne: unsupported,
    updateOne: unsupported,
    softDelete: unsupported,
    async listPage(ctx, options = {}) {
      const limit = typeof options.limit === "number" ? options.limit : 25;
      const found = visible(ctx, options.filter);
      return {
        items: found.slice(0, limit),
        meta: { limit, hasMore: found.length > limit, cursor: null },
      };
    },
  };
}
