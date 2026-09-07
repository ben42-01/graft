/**
 * The privacy statement is a legal artefact rendered on two pages and served
 * as a download, so what is pinned here is its integrity as a document: no
 * empty sections, a version and date that the Markdown carries, and the
 * contact address actually present in the text people download.
 */
import { describe, expect, it } from "vitest";
import {
  EFFECTIVE_DATE,
  PRIVACY_CONTACT_EMAIL,
  PRIVACY_SECTIONS,
  VERSION,
  privacyMarkdown,
} from "./privacy";

describe("PRIVACY_SECTIONS", () => {
  it("has no empty section, heading or bullet", () => {
    expect(PRIVACY_SECTIONS.length).toBeGreaterThan(0);
    for (const section of PRIVACY_SECTIONS) {
      expect(section.heading.trim()).not.toBe("");
      expect(section.blocks.length).toBeGreaterThan(0);
      for (const block of section.blocks) {
        if (block.kind === "p") expect(block.text.trim()).not.toBe("");
        else {
          expect(block.items.length).toBeGreaterThan(0);
          for (const item of block.items) expect(item.trim()).not.toBe("");
        }
      }
    }
  });

  it("uses unique section ids — they are anchor targets", () => {
    const ids = PRIVACY_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("privacyMarkdown", () => {
  it("carries the version, date and contact address the page shows", () => {
    const markdown = privacyMarkdown();
    expect(markdown).toContain(`Version ${VERSION}`);
    expect(markdown).toContain(EFFECTIVE_DATE);
    expect(markdown).toContain(PRIVACY_CONTACT_EMAIL);
  });

  it("renders every section as a heading, with its bullets as list items", () => {
    const markdown = privacyMarkdown();
    for (const section of PRIVACY_SECTIONS) {
      expect(markdown).toContain(`## ${section.heading}`);
      for (const block of section.blocks) {
        if (block.kind === "ul") {
          for (const item of block.items) expect(markdown).toContain(`- ${item}`);
        }
      }
    }
  });
});
