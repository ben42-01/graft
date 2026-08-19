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

  it("falls back to / for null or empty", () => {
    expect(sanitizeRedirectTarget(null)).toBe("/");
    expect(sanitizeRedirectTarget(undefined)).toBe("/");
    expect(sanitizeRedirectTarget("")).toBe("/");
  });

  it("falls back to / for an absolute URL", () => {
    expect(sanitizeRedirectTarget("https://evil.com")).toBe("/");
    expect(sanitizeRedirectTarget("http://evil.com/path")).toBe("/");
  });

  it("falls back to / for a protocol-relative URL", () => {
    expect(sanitizeRedirectTarget("//evil.com")).toBe("/");
  });

  it("falls back to / for a value that doesn't start with a slash", () => {
    expect(sanitizeRedirectTarget("dashboards")).toBe("/");
  });
});
