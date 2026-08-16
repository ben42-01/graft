/**
 * Cursor pagination (docs/BACKEND.md §2).
 *
 * The cursor is opaque on purpose: clients get an encoded token, not a
 * document id they can arithmetic on, so the sort key can change later without
 * breaking anyone. It is encoding, not encryption — it carries no secret, and
 * anything it names is still re-checked against `ctx.tenantId` by the repository.
 */
import { z } from "zod";
import { AppError } from "./envelope";

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

/**
 * The id is a Mongo ObjectId hex, matching `objectIdHex` in context.ts. It was
 * `z.string().min(1)` until GRAFT-02.1 (AC3): any non-empty string passed the
 * boundary and reached `new ObjectId(...)` in the repository, which threw a raw
 * BSONError and surfaced as a 500 INTERNAL. A client-supplied value must never
 * produce a 500 — it is a 400 or it is nothing.
 */
const cursorSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{24}$/i, "Expected a 24-character id"),
  at: z.string().optional(),
});

/** What a cursor points at: the last item of the page just served. */
export type CursorPayload = z.infer<typeof cursorSchema>;

export type PageMeta = { limit: number; hasMore: boolean; cursor: string | null };

const invalidCursor = () =>
  new AppError("VALIDATION_FAILED", "Invalid cursor", {
    source: "query",
    fields: { cursor: "Not a cursor issued by this API" },
  });

export function encodeCursor(payload: CursorPayload): string {
  // An id we could not page on is not a cursor: raise the same 400 rather than
  // letting a ZodError escape as a 500.
  const parsed = cursorSchema.safeParse(payload);
  if (!parsed.success) throw invalidCursor();
  return Buffer.from(JSON.stringify(parsed.data), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorPayload {
  const invalid = invalidCursor;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  const parsed = cursorSchema.safeParse(decoded);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

/** A missing or silly limit is corrected, never rejected — this is a UI knob. */
export function clampLimit(raw: unknown): number {
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

/**
 * Turns an over-fetch of `limit + 1` rows into a page and its meta. Reading one
 * extra row is how `hasMore` is known without a second count query.
 */
export function page<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => CursorPayload,
): { items: T[]; meta: PageMeta } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    meta: { limit, hasMore, cursor: hasMore && last ? encodeCursor(cursorOf(last)) : null },
  };
}
