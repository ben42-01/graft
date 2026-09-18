import { describe, expect, it } from "vitest";
import { policyForPath } from "./policy";

/**
 * The declarative half of "a route states its scope" (issue Scope): a route may
 * pass its own policy to `route()`, and everything that does not gets the one
 * this table assigns by path. A new endpoint is therefore rate limited by
 * default — the security checklist item is satisfied by omission, not by memory.
 */
describe("policyForPath", () => {
  it("puts credential endpoints on the ip+email auth scope", () => {
    expect(policyForPath("/api/v1/auth/login").scopes).toEqual(["global-ip", "auth"]);
    expect(policyForPath("/api/v1/auth/signup").scopes).toEqual(["global-ip", "auth"]);
  });

  it("puts the public form surface on the ip+form scope", () => {
    expect(policyForPath("/api/v1/public/forms/contact/submissions").scopes).toEqual([
      "global-ip",
      "public-form",
    ]);
  });

  it("gives every other v1 route the global, tenant and user scopes", () => {
    expect(policyForPath("/api/v1/me").scopes).toEqual(["global-ip", "api", "user"]);
    expect(policyForPath("/api/v1/entities/x/records").scopes).toEqual([
      "global-ip",
      "api",
      "user",
    ]);
  });

  /**
   * GRAFT-27.1 AC9 — the platform-admin surface is rate limited by the same
   * `^/api/v1/` row as everything else authenticated, and deliberately has no
   * row of its own. Pinned here so the surface cannot become unlimited by
   * someone later adding a more specific pattern above it and forgetting the
   * scopes: this test fails the moment `/api/v1/admin/*` stops matching
   * `["global-ip", "api", "user"]`.
   */
  it("rate limits the platform-admin surface exactly like any other v1 route", () => {
    expect(policyForPath("/api/v1/admin/session").scopes).toEqual(["global-ip", "api", "user"]);
    expect(policyForPath("/api/v1/admin/tenants").scopes).toEqual(["global-ip", "api", "user"]);
    // Including a path no route claims — the catch-all answers it, and it is
    // charged for the attempt just the same.
    expect(policyForPath("/api/v1/admin/does-not-exist").scopes).toEqual([
      "global-ip",
      "api",
      "user",
    ]);
  });

  /**
   * Session rotation is not a credential-guessing surface — the refresh cookie
   * either verifies or it does not — and a shared 5-per-15-minutes budget would
   * lock out a browser doing nothing wrong.
   */
  it("leaves session rotation on the global scope only", () => {
    expect(policyForPath("/api/v1/auth/refresh").scopes).toEqual(["global-ip"]);
    expect(policyForPath("/api/v1/auth/logout").scopes).toEqual(["global-ip"]);
  });

  it("does not limit the liveness and readiness probes", () => {
    expect(policyForPath("/api/health").scopes).toEqual([]);
    expect(policyForPath("/api/ready").scopes).toEqual([]);
  });

  it("falls back to the global scope for anything unrecognised", () => {
    expect(policyForPath("/api/v2/something").scopes).toEqual(["global-ip"]);
  });
});
