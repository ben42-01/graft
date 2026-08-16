import { describe, expect, it } from "vitest";
import {
  OUTAGE_POLICY,
  RATE_LIMIT_SCOPES,
  clientIp,
  keyFor,
  limitFor,
  resetEpochSeconds,
  retryAfterSeconds,
  UNKNOWN_IP,
} from "./scopes";

/**
 * The pure half of GRAFT-04: which limit applies, what it is keyed on, and what
 * the client is told to do about it. Everything here is data and arithmetic, so
 * it is tested without Redis and without a request pipeline.
 */

describe("limitFor", () => {
  // AC2 — per-tier limits for authenticated traffic (docs/BACKEND.md §4).
  it("gives a Free tenant 60/min and a Premium tenant 600/min on the API scope", () => {
    expect(limitFor("api", "free")).toEqual({ points: 60, durationSeconds: 60 });
    expect(limitFor("api", "premium")).toEqual({ points: 600, durationSeconds: 60 });
  });

  it("gives Enterprise a higher ceiling than Premium", () => {
    expect(limitFor("api", "enterprise").points).toBeGreaterThan(
      limitFor("api", "premium").points,
    );
  });

  /**
   * A tier-derived scope with no tier is a bug somewhere upstream; the safe
   * reading of an unknown tenant is the most restrictive one, never the loosest.
   */
  it("falls back to the Free limit when no tier is known", () => {
    expect(limitFor("api")).toEqual(limitFor("api", "free"));
    expect(limitFor("connector")).toEqual(limitFor("connector", "free"));
  });

  it("uses the fixed limits from the §4 table for the untiered scopes", () => {
    expect(limitFor("global-ip")).toEqual({ points: 300, durationSeconds: 60 });
    expect(limitFor("auth")).toEqual({ points: 5, durationSeconds: 900 });
    expect(limitFor("user")).toEqual({ points: 120, durationSeconds: 60 });
    expect(limitFor("public-form")).toEqual({ points: 10, durationSeconds: 60 });
  });

  it("scales the connector scope by tier too", () => {
    expect(limitFor("connector", "premium").points).toBeGreaterThan(
      limitFor("connector", "free").points,
    );
  });
});

describe("keyFor", () => {
  const ip = "203.0.113.7";

  // AC4 — scopes are independent because their keyspaces cannot collide.
  it("prefixes every scope's key with the scope name", () => {
    const keys = RATE_LIMIT_SCOPES.map((scope) =>
      keyFor(scope, {
        ip,
        email: "a@qa.test",
        tenantId: "000000000000000000000001",
        userId: "00000000000000000000000b",
        formId: "contact",
        tokenId: "tok_1",
      }),
    );
    expect(new Set(keys).size).toBe(RATE_LIMIT_SCOPES.length);
    for (const [index, scope] of RATE_LIMIT_SCOPES.entries()) {
      expect(keys[index]).toMatch(new RegExp(`^rl:${scope}:`));
    }
  });

  it("keys the same IP under global-ip and public-form separately", () => {
    expect(keyFor("global-ip", { ip })).not.toBe(
      keyFor("public-form", { ip, formId: "contact" }),
    );
  });

  // AC4 again, at the tenant level: one tenant's budget is its own.
  it("gives two tenants different API keys", () => {
    expect(keyFor("api", { tenantId: "000000000000000000000001" })).not.toBe(
      keyFor("api", { tenantId: "000000000000000000000002" }),
    );
  });

  // AC3 — auth is keyed on ip + email, and the email never lands in Redis raw.
  it("keys auth on ip and email together", () => {
    const a = keyFor("auth", { ip, email: "one@qa.test" });
    const b = keyFor("auth", { ip, email: "two@qa.test" });
    const c = keyFor("auth", { ip: "198.51.100.9", email: "one@qa.test" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain("one@qa.test");
    expect(a).not.toContain("qa.test");
  });

  it("treats the same address in different casing as one identity", () => {
    expect(keyFor("auth", { ip, email: " One@QA.test " })).toBe(
      keyFor("auth", { ip, email: "one@qa.test" }),
    );
  });

  it("returns null when the identity a scope needs is absent", () => {
    expect(keyFor("auth", { ip })).toBeNull();
    expect(keyFor("api", {})).toBeNull();
    expect(keyFor("user", {})).toBeNull();
    expect(keyFor("public-form", { ip })).toBeNull();
    expect(keyFor("connector", {})).toBeNull();
  });
});

describe("clientIp", () => {
  const withHeaders = (headers: Record<string, string>) =>
    new Request("http://localhost/api/v1/things", { headers });

  it("reads the first hop of x-forwarded-for", () => {
    expect(clientIp(withHeaders({ "x-forwarded-for": "203.0.113.7, 70.41.3.18" }))).toBe(
      "203.0.113.7",
    );
  });

  it("falls back to x-real-ip", () => {
    expect(clientIp(withHeaders({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  /**
   * Constraint: "never key a limit on a client-supplied header alone." The
   * defence that matters here is that an unparseable value cannot mint a new
   * bucket — a spoofer gets the shared `unknown` bucket, not an empty one.
   */
  it("buckets an unparseable or absent forwarding header under one shared key", () => {
    expect(clientIp(withHeaders({ "x-forwarded-for": "not-an-ip" }))).toBe(UNKNOWN_IP);
    expect(clientIp(withHeaders({ "x-forwarded-for": "'; DROP TABLE" }))).toBe(UNKNOWN_IP);
    expect(clientIp(withHeaders({}))).toBe(UNKNOWN_IP);
  });

  it("accepts IPv6 and strips a port", () => {
    expect(clientIp(withHeaders({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(clientIp(withHeaders({ "x-forwarded-for": "203.0.113.7:51234" }))).toBe(
      "203.0.113.7",
    );
    expect(clientIp(withHeaders({ "x-forwarded-for": "[2001:db8::1]:443" }))).toBe(
      "2001:db8::1",
    );
  });
});

describe("retry semantics", () => {
  // AC1 — Retry-After is in whole seconds and never advertises "try again now".
  it("rounds the wait up to the next whole second", () => {
    expect(retryAfterSeconds(1)).toBe(1);
    expect(retryAfterSeconds(1_001)).toBe(2);
    expect(retryAfterSeconds(60_000)).toBe(60);
  });

  it("never returns zero or a negative wait", () => {
    expect(retryAfterSeconds(0)).toBe(1);
    expect(retryAfterSeconds(-5)).toBe(1);
  });

  it("expresses the reset as an epoch second in the future", () => {
    const now = 1_760_000_000_000;
    expect(resetEpochSeconds(30_000, now)).toBe(1_760_000_030);
  });
});

describe("outage policy", () => {
  // AC7 — the two directions the contract names, stated as data.
  it("fails closed for the public form scope", () => {
    expect(OUTAGE_POLICY["public-form"]).toBe("closed");
  });

  it("fails open for authenticated API traffic", () => {
    expect(OUTAGE_POLICY.api).toBe("open");
    expect(OUTAGE_POLICY.user).toBe("open");
  });

  it("declares a mode for every scope, so no scope can be silently unhandled", () => {
    for (const scope of RATE_LIMIT_SCOPES) {
      expect(["open", "closed"]).toContain(OUTAGE_POLICY[scope]);
    }
  });
});
