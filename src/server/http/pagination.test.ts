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
  const rows = [{ _id: "a" }, { _id: "b" }, { _id: "c" }];
  const cursorOf = (row: { _id: string }) => ({ id: row._id });

  it("returns a full page with a cursor when there is more", () => {
    const result = page(rows, 2, cursorOf);
    expect(result.items).toEqual([{ _id: "a" }, { _id: "b" }]);
    expect(result.meta.hasMore).toBe(true);
    expect(decodeCursor(result.meta.cursor!)).toEqual({ id: "b" });
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
