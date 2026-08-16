/** AC7 — the flags, and the opaque-token format they carry. */
import { describe, expect, it } from "vitest";
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  accessCookie,
  clearedCookies,
  readAccessToken,
  readCookie,
  refreshCookie,
} from "./cookies";
import { generateRefreshToken, hashRefreshToken, parseRefreshToken } from "./refresh-tokens";

const TENANT = "000000000000000000000001";
const request = (headers: Record<string, string>) =>
  new Request("http://localhost/api/v1/auth/refresh", { headers });

describe("refresh cookie (AC7)", () => {
  const cookie = refreshCookie(`${TENANT}.abcdefghijklmnopqrstuvwxyz`, 2_592_000);

  it("is httpOnly, Secure and SameSite=Lax", () => {
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("is only sent to the auth endpoints that can spend it", () => {
    expect(cookie).toContain("Path=/api/v1/auth");
    expect(accessCookie("a.b.c", 900)).toContain("Path=/");
  });

  it("clears with the same name, path and flags it was set with", () => {
    const cleared = clearedCookies();
    expect(cleared).toHaveLength(2);
    for (const one of cleared) {
      expect(one).toContain("Max-Age=0");
      expect(one).toContain("HttpOnly");
      expect(one).toContain("Secure");
    }
    expect(cleared[0]).toContain(`${REFRESH_COOKIE}=`);
    expect(cleared[0]).toContain("Path=/api/v1/auth");
    expect(cleared[1]).toContain(`${ACCESS_COOKIE}=`);
  });
});

describe("refresh token format (AC7)", () => {
  it("is opaque — two segments, not a JWT", () => {
    const token = generateRefreshToken(TENANT);
    expect(token.split(".")).toHaveLength(2);
    expect(parseRefreshToken(token)).toEqual({ tenantId: TENANT, token });
  });

  it("is unguessable and hashed before storage", () => {
    const a = generateRefreshToken(TENANT);
    const b = generateRefreshToken(TENANT);
    expect(a).not.toBe(b);
    expect(hashRefreshToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRefreshToken(a)).not.toContain(a.split(".")[1]);
    expect(hashRefreshToken(a)).toBe(hashRefreshToken(a));
  });

  it("rejects anything that is not <24-hex tenant>.<secret>", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "no-separator",
      `${TENANT}.short`,
      "not-hex-at-all-not-hex-at.abcdefghijklmnopqrstuvwxyz",
      `${TENANT}.has spaces in the secret value`,
      `${TENANT}.$ne`,
    ]) {
      expect(parseRefreshToken(bad)).toBeNull();
    }
  });
});

describe("readAccessToken", () => {
  it("prefers the Authorization header, for connectors with no cookie jar", () => {
    expect(readAccessToken(request({ authorization: "Bearer a.b.c" }))).toBe("a.b.c");
    expect(readAccessToken(request({ authorization: "bearer a.b.c" }))).toBe("a.b.c");
  });

  it("falls back to the httpOnly cookie for the browser app", () => {
    const cookie = `other=1; ${ACCESS_COOKIE}=a.b.c; trailing=2`;
    expect(readAccessToken(request({ cookie }))).toBe("a.b.c");
    expect(readCookie(request({ cookie }), REFRESH_COOKIE)).toBeNull();
  });

  it("refuses a malformed Authorization header rather than guessing", () => {
    for (const authorization of ["Basic abc", "Bearer", "Bearer a b", "a.b.c"]) {
      expect(readAccessToken(request({ authorization }))).toBeNull();
    }
    expect(readAccessToken(request({}))).toBeNull();
  });
});
