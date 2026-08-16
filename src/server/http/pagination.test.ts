import { describe, expect, it } from "vitest";
import { AppError } from "./envelope";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  clampLimit,
  decodeCursor,
  encodeCursor,
  page,
} from "./pagination";

describe("cursor", () => {
  // AC8 — the cursor is opaque and round-trips.
  it("round-trips a payload", () => {
    const payload = { id: "6890000000000000000000ff", at: "2026-01-15T12:00:00.000Z" };
    const cursor = encodeCursor(payload);
    expect(cursor).not.toContain(payload.id);
    expect(decodeCursor(cursor)).toEqual(payload);
  });

  it("is url-safe", () => {
    const cursor = encodeCursor({ id: "6890000000000000000000ff" });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });

  it("rejects a tampered or foreign cursor as a validation failure", () => {
    for (const bad of ["not-a-cursor", "", Buffer.from('{"id":42}').toString("base64url")]) {
      expect(() => decodeCursor(bad)).toThrow(AppError);
      try {
        decodeCursor(bad);
      } catch (error) {
        expect((error as AppError).code).toBe("VALIDATION_FAILED");
      }
    }
  });

  /**
   * GRAFT-02.1 AC3 (F2) — the cursor id used to be any non-empty string, so a
   * client-supplied value reached `new ObjectId(...)` in the repository and threw
   * a raw BSONError that surfaced as a 500 INTERNAL. A client value must never
   * produce a 500: the id is now validated as 24-hex at the boundary.
   */
  describe("a malformed cursor id is a 400, never a 500 (AC3)", () => {
    const cursorFor = (id: unknown) =>
      Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url");

    it("rejects a decoded id that is not an ObjectId", () => {
      for (const id of [
        "not-an-object-id",
        "689000000000000000000",
        "6890000000000000000000fff",
        "6890000000000000000000zz",
        "../../etc/passwd",
        "6890000000000000000000ff ",
      ]) {
        let thrown: unknown;
        try {
          decodeCursor(cursorFor(id));
        } catch (error) {
          thrown = error;
        }
        expect(thrown, `id ${JSON.stringify(id)} must be rejected`).toBeInstanceOf(AppError);
        expect((thrown as AppError).code).toBe("VALIDATION_FAILED");
        expect((thrown as AppError).status).toBe(400);
      }
    });

    it("still accepts a real ObjectId in either case", () => {
      expect(decodeCursor(cursorFor("6890000000000000000000ff")).id).toBe(
        "6890000000000000000000ff",
      );
      expect(decodeCursor(cursorFor("6890000000000000000000FF")).id).toBe(
        "6890000000000000000000FF",
      );
    });

    // The same invariant on the way out — an id we cannot page on is not a cursor.
    it("refuses to encode a non-ObjectId id", () => {
      expect(() => encodeCursor({ id: "not-an-object-id" })).toThrow(AppError);
      try {
        encodeCursor({ id: "not-an-object-id" });
      } catch (error) {
        expect((error as AppError).code).toBe("VALIDATION_FAILED");
        expect((error as AppError).status).toBe(400);
      }
    });
  });
});

describe("clampLimit", () => {
  it("defaults and clamps", () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(10)).toBe(10);
    expect(clampLimit(5_000)).toBe(MAX_LIMIT);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-3)).toBe(1);
    expect(clampLimit("nonsense")).toBe(DEFAULT_LIMIT);
  });
});

describe("page", () => {
  // Real ObjectId hex since AC3 — a page cursor is built from a document _id.
  const ids = [
    "6890000000000000000000a1",
    "6890000000000000000000b2",
    "6890000000000000000000c3",
  ];
  const rows = ids.map((_id) => ({ _id }));
  const cursorOf = (row: { _id: string }) => ({ id: row._id });

  it("returns a full page with a cursor when there is more", () => {
    const result = page(rows, 2, cursorOf);
    expect(result.items).toEqual([{ _id: ids[0] }, { _id: ids[1] }]);
    expect(result.meta.hasMore).toBe(true);
    expect(decodeCursor(result.meta.cursor!)).toEqual({ id: ids[1] });
    expect(result.meta.limit).toBe(2);
  });

  it("returns a null cursor on the last page", () => {
    const result = page(rows, 5, cursorOf);
    expect(result.items).toHaveLength(3);
    expect(result.meta.hasMore).toBe(false);
    expect(result.meta.cursor).toBeNull();
  });

  it("handles an empty result", () => {
    const result = page([], 25, cursorOf);
    expect(result.items).toEqual([]);
    expect(result.meta).toEqual({ limit: 25, hasMore: false, cursor: null });
  });
});
