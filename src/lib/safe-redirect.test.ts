/**
 * GRAFT-18 AC7 — open-redirect guard unit coverage. The binding contract is
 * the E2E case in e2e/login.spec.ts; this is the light component-level test
 * the Test Contract calls "welcome".
 */
import { describe, expect, it } from "vitest";
import { sanitizeRedirectTarget } from "./safe-redirect";

describe("sanitizeRedirectTarget", () => {
  it("passes through a same-origin relative path", () => {
    expect(sanitizeRedirectTarget("/dashboards")).toBe("/dashboards");
  });

  it("falls back to /home for null or empty", () => {
    expect(sanitizeRedirectTarget(null)).toBe("/home");
    expect(sanitizeRedirectTarget(undefined)).toBe("/home");
    expect(sanitizeRedirectTarget("")).toBe("/home");
  });

  it("falls back to /home for an absolute URL", () => {
    expect(sanitizeRedirectTarget("https://evil.com")).toBe("/home");
    expect(sanitizeRedirectTarget("http://evil.com/path")).toBe("/home");
  });

  it("falls back to /home for a protocol-relative URL", () => {
    expect(sanitizeRedirectTarget("//evil.com")).toBe("/home");
  });

  it("falls back to /home for a value that doesn't start with a slash", () => {
    expect(sanitizeRedirectTarget("dashboards")).toBe("/home");
  });
});
