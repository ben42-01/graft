import { describe, expect, it } from "vitest";
import { isSafeLinkUrl, placeContent, type ContentBlock } from "./content-blocks";

describe("isSafeLinkUrl", () => {
  it("accepts ordinary web addresses", () => {
    expect(isSafeLinkUrl("https://example.com/terms")).toBe(true);
    expect(isSafeLinkUrl("http://example.co.uk/cancellations?lang=en#refunds")).toBe(true);
  });

  it("refuses anything that can run script or is not a link", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "ftp://example.com/terms",
      "//example.com/terms",
      "/terms",
      "example.com",
      "",
    ]) {
      expect(isSafeLinkUrl(bad), bad).toBe(false);
    }
  });

  it("refuses credentials in the address and hosts a customer cannot reach", () => {
    expect(isSafeLinkUrl("https://user:pw@example.com")).toBe(false);
    expect(isSafeLinkUrl("http://localhost:3000")).toBe(false);
  });

  it("refuses an absurdly long address", () => {
    expect(isSafeLinkUrl(`https://example.com/${"a".repeat(2_100)}`)).toBe(false);
  });
});

describe("placeContent", () => {
  const fields = [{ key: "name" }, { key: "date" }];
  const block = (id: string, after: string | null): ContentBlock => ({
    id,
    kind: "notice",
    title: "",
    body: id,
    after,
  });

  it("puts top blocks first, then each field followed by its blocks, in stored order", () => {
    const items = placeContent(fields, [
      block("afterDate", "date"),
      block("top", null),
      block("afterName1", "name"),
      block("afterName2", "name"),
    ]);
    expect(items.map((i) => (i.kind === "field" ? i.field.key : i.block.id))).toEqual([
      "top",
      "name",
      "afterName1",
      "afterName2",
      "date",
      "afterDate",
    ]);
  });

  it("keeps a block whose field left the form, at the end rather than dropping it", () => {
    const items = placeContent(fields, [block("orphan", "removed_field")]);
    expect(items.at(-1)).toEqual({ kind: "block", block: block("orphan", "removed_field") });
  });
});
