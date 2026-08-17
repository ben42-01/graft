/** AC6 — WCAG AA contrast pairing against a tenant-chosen colour. */
import { describe, expect, it } from "vitest";
import { contrastingTextColor } from "./contrast";

describe("contrastingTextColor", () => {
  it("picks black text on a light brand colour", () => {
    expect(contrastingTextColor("#ffffff")).toBe("#000000");
    expect(contrastingTextColor("#fde047")).toBe("#000000");
  });

  it("picks white text on a dark brand colour", () => {
    expect(contrastingTextColor("#000000")).toBe("#ffffff");
    expect(contrastingTextColor("#1d4ed8")).toBe("#ffffff");
  });

  it("falls back to black-on-white for missing or unparseable input", () => {
    expect(contrastingTextColor(null)).toBe("#000000");
    expect(contrastingTextColor(undefined)).toBe("#000000");
    expect(contrastingTextColor("not-a-color")).toBe("#000000");
  });
});
