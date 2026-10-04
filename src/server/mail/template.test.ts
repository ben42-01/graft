import { describe, expect, it } from "vitest";
import { escapeHtml, renderEmail } from "./template";

const content = {
  preheader: "Preview line",
  heading: "Confirm your email address",
  paragraphs: ["First paragraph.", "Second paragraph."],
  action: { label: "Confirm email", url: "https://app.example.test/verify-email?token=abc" },
  footnote: "This link works once.",
  signoff: "Harbour Boats",
};

describe("renderEmail", () => {
  it("puts every part in both the HTML and the plain-text version", () => {
    const { html, text } = renderEmail(content);
    for (const part of [
      content.heading,
      ...content.paragraphs,
      content.action.label,
      content.footnote,
      content.signoff,
    ]) {
      expect(html).toContain(part);
      expect(text).toContain(part);
    }
    expect(html).toContain(content.preheader);
    expect(text).toContain(`Confirm email: ${content.action.url}`);
  });

  it("links the button and prints the URL as a fallback", () => {
    const { html } = renderEmail(content);
    const href = escapeHtml(content.action.url);
    expect(html.split(`href="${href}"`)).toHaveLength(3);
  });

  it("escapes tenant-chosen text instead of rendering it as HTML", () => {
    const { html } = renderEmail({
      ...content,
      heading: `<script>alert("x")</script>`,
      signoff: `Tom & Jerry's <b>Boats</b>`,
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>Boats</b>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Tom &amp; Jerry&#39;s &lt;b&gt;Boats&lt;/b&gt;");
  });

  it("refuses a button link that is not http(s)", () => {
    expect(() =>
      renderEmail({ ...content, action: { label: "Pay", url: "javascript:alert(1)" } }),
    ).toThrow(/javascript:/);
  });

  it("leaves out the optional parts cleanly", () => {
    const { html, text } = renderEmail({
      preheader: "p",
      heading: "Hello",
      paragraphs: ["Body."],
    });
    expect(html).not.toContain("<a href");
    expect(text).toBe("Hello\n\nBody.\n\nSent with Graft");
  });
});
