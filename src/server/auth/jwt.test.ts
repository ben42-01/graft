/**
 * AC4, precisely. The Bruno suite proves a bad token is refused at the wire;
 * this proves *which* things count as bad, at the exact boundary.
 */
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppError } from "@/server/http/envelope";
import { CLOCK_SKEW_SECONDS, signJwt, verifyJwt } from "./jwt";

const pair = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const ours = pair();
const theirs = pair();

const KID = "test-kid";
const keys: ReadonlyMap<string, KeyObject> = new Map([[KID, ours.publicKey]]);

const NOW = Date.UTC(2026, 7, 16, 12, 0, 0);
const seconds = Math.floor(NOW / 1000);

const token = (claims: Record<string, unknown> = {}, privateKey = ours.privateKey, kid = KID) =>
  signJwt(
    { sub: "00000000000000000000000b", iat: seconds, exp: seconds + 900, ...claims },
    { kid, privateKey },
  );

const expectUnauthorized = (run: () => unknown) => {
  try {
    run();
    expect.unreachable("this token must not verify");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("UNAUTHORIZED");
    // The message is identical for every failure — which check failed is not
    // something a caller gets to learn by probing.
    expect((error as AppError).message).toBe("Invalid or expired token");
  }
};

describe("signJwt", () => {
  it("produces a three-part RS256 token naming the signing kid", () => {
    const parts = token().split(".");
    expect(parts).toHaveLength(3);
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    expect(header).toEqual({ alg: "RS256", typ: "JWT", kid: KID });
  });

  it("round-trips the claims it was given", () => {
    const claims = verifyJwt(token({ tid: "000000000000000000000001" }), keys, NOW);
    expect(claims.tid).toBe("000000000000000000000001");
    expect(claims.sub).toBe("00000000000000000000000b");
  });
});

describe("verifyJwt (AC4)", () => {
  it("refuses a token signed by the wrong key", () => {
    expectUnauthorized(() => verifyJwt(token({}, theirs.privateKey), keys, NOW));
  });

  it("refuses a token whose kid we never published", () => {
    expectUnauthorized(() => verifyJwt(token({}, ours.privateKey, "rotated-away"), keys, NOW));
  });

  it("refuses a tampered payload even though the signature is intact", () => {
    const [header, payload, signature] = token({ tid: "000000000000000000000001" }).split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    claims.tid = "000000000000000000000002";
    const forged = Buffer.from(JSON.stringify(claims)).toString("base64url");
    expectUnauthorized(() => verifyJwt(`${header}.${forged}.${signature}`, keys, NOW));
  });

  it('refuses "alg": "none" and any algorithm substitution', () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: KID })).toString(
      "base64url",
    );
    const payload = Buffer.from(JSON.stringify({ iat: seconds, exp: seconds + 900 })).toString(
      "base64url",
    );
    expectUnauthorized(() => verifyJwt(`${header}.${payload}.`, keys, NOW));
    expectUnauthorized(() => verifyJwt(`${header}.${payload}.anything`, keys, NOW));
  });

  it("refuses anything that is not three base64url segments", () => {
    for (const bad of ["", "a", "a.b", "a.b.c.d", "not-a-jwt"]) {
      expectUnauthorized(() => verifyJwt(bad, keys, NOW));
    }
  });

  it("refuses a token with no exp, or a non-numeric one", () => {
    expectUnauthorized(() => verifyJwt(token({ exp: undefined }), keys, NOW));
    expectUnauthorized(() => verifyJwt(token({ exp: "later" }), keys, NOW));
    expectUnauthorized(() => verifyJwt(token({ iat: "before" }), keys, NOW));
  });

  describe("expiry boundary", () => {
    const expiring = token({ exp: seconds + 10 });

    it("accepts a token up to the skew allowance past its exp", () => {
      const justInside = (seconds + 10 + CLOCK_SKEW_SECONDS - 1) * 1000;
      expect(verifyJwt(expiring, keys, justInside).exp).toBe(seconds + 10);
    });

    it("refuses it once the allowance is spent", () => {
      const justOutside = (seconds + 10 + CLOCK_SKEW_SECONDS) * 1000;
      expectUnauthorized(() => verifyJwt(expiring, keys, justOutside));
    });

    it("refuses a token issued further in the future than the skew allows", () => {
      const fromTheFuture = token({ iat: seconds + CLOCK_SKEW_SECONDS + 1 });
      expectUnauthorized(() => verifyJwt(fromTheFuture, keys, NOW));
    });
  });
});
