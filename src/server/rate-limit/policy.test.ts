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
