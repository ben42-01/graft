/**
 * AC5 — slug generation. Collision handling is the store's unique index and is
 * proven in accounts.test.ts and the integration test; this covers the derivation.
 */
import { describe, expect, it } from "vitest";
import { RESERVED_SLUGS, isReservedSlug, slugify } from "./slugs";

describe("slugify", () => {
  it("lowercases and dashes an ordinary business name", () => {
    expect(slugify("Bella's Barbershop")).toBe("bellas-barbershop");
    expect(slugify("O'Shea Plumbing")).toBe("oshea-plumbing");
  });

  it("folds accents to ASCII rather than dropping the characters", () => {
    // "Café Ubiquitous" must not become "caf-ubiquitous".
    expect(slugify("Café Ubiquitous")).toBe("cafe-ubiquitous");
    expect(slugify("Ólafur Ísland")).toBe("olafur-island");
  });

  it("collapses runs of separators and trims the ends", () => {
    expect(slugify("  Shannon   ---  Logistics  ")).toBe("shannon-logistics");
    expect(slugify("!!!Hello!!!")).toBe("hello");
  });

  it("bounds the length, and never ends on a dash after truncation", () => {
    const slug = slugify("a".repeat(40) + " " + "b".repeat(40))!;
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("returns null when nothing usable survives, rather than an empty slug", () => {
    // The caller turns this into a validation error; an empty slug would
    // otherwise collide with every other unusable name.
    expect(slugify("!!!")).toBeNull();
    expect(slugify("   ")).toBeNull();
    expect(slugify("日本語")).toBeNull();
  });
});

describe("isReservedSlug", () => {
  it("blocks names that would shadow a platform route", () => {
    // Public forms live at /f/{tenantSlug}/{formSlug} (docs/Graft.md §134), so a
    // tenant called "api" or "admin" is a routing problem, not a naming quirk.
    for (const reserved of RESERVED_SLUGS) expect(isReservedSlug(reserved)).toBe(true);
    expect(isReservedSlug("API")).toBe(true);
    expect(isReservedSlug("bellas-barbershop")).toBe(false);
  });
});
