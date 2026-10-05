import { describe, expect, it } from "vitest";
import { DEVELOPER_DOCS_URL, DOCS_URL } from "./docs-links";

describe("docs links", () => {
  it("point at the docs site, with the developer link inside it", () => {
    expect(DOCS_URL).toMatch(/^https:\/\/.+\/$/);
    expect(DEVELOPER_DOCS_URL.startsWith(DOCS_URL)).toBe(true);
    expect(DEVELOPER_DOCS_URL.endsWith("/developers/overview/")).toBe(true);
  });
});
