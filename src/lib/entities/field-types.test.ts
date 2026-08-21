/**
 * Pins the client-side field-type catalog against the server's `FIELD_TYPES`
 * (a type the server rejects would fail `createEntitySchema` at POST time),
 * and covers the identifier derivation the builder relies on to produce keys
 * the server will accept.
 */
import { describe, expect, it } from "vitest";
import { FIELD_TYPES } from "@/server/services/entities";
import { FIELD_TYPE_OPTIONS, UNOFFERED_FIELD_TYPES, toIdentifier } from "./field-types";

describe("FIELD_TYPE_OPTIONS", () => {
  it("offers every server field type except the explicitly unoffered ones", () => {
    const offered = FIELD_TYPE_OPTIONS.map((option) => option.type);
    expect([...offered, ...UNOFFERED_FIELD_TYPES].sort()).toEqual([...FIELD_TYPES].sort());
  });
});

describe("toIdentifier", () => {
  it("produces keys the server's identifier regex accepts", () => {
    const identifier = /^[a-z][a-z0-9_]*$/;
    for (const input of ["Name", "Email address", "  Due date  ", "Total (€)", "phone#2"]) {
      expect(toIdentifier(input)).toMatch(identifier);
    }
  });

  it("strips leading non-letters, collapses separators and trims to the max", () => {
    expect(toIdentifier("123 Street")).toBe("street");
    expect(toIdentifier("First   name")).toBe("first_name");
    expect(toIdentifier("Ends with symbol!")).toBe("ends_with_symbol");
    expect(toIdentifier("abcdef", 3)).toBe("abc");
  });

  it("returns an empty string when nothing usable survives", () => {
    expect(toIdentifier("!!!")).toBe("");
    expect(toIdentifier("123")).toBe("");
  });
});
