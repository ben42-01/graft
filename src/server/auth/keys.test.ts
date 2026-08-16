/** AC1 and AC8 — what JWKS publishes, and what it must never publish. */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signJwt, verifyJwt, publicKeyFromPem } from "./jwt";
import { buildKeyring, jwkFor, kidFor } from "./keys";

const pem = () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKey, publicKey };
};

const current = pem();
const previous = pem();

describe("kidFor", () => {
  it("is derived from the key, so it cannot drift out of step with it", () => {
    const key = publicKeyFromPem(current.publicKey);
    expect(kidFor(key)).toBe(kidFor(publicKeyFromPem(current.publicKey)));
    expect(kidFor(key)).not.toBe(kidFor(publicKeyFromPem(previous.publicKey)));
    expect(kidFor(key)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("jwkFor", () => {
  it("publishes the public half and nothing else", () => {
    const jwk = jwkFor(publicKeyFromPem(current.publicKey));
    expect(Object.keys(jwk).sort()).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
    expect(jwk).toMatchObject({ kty: "RSA", use: "sig", alg: "RS256", e: "AQAB" });
  });

  /**
   * The regression this guards: an implementation that spread the JWK export
   * would publish `d`, `p` and `q` the day someone handed it a private key.
   */
  it("carries no private component even when handed a private key", () => {
    const jwk = jwkFor(
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey,
    ) as unknown as Record<string, unknown>;
    for (const secret of ["d", "p", "q", "dp", "dq", "qi"]) {
      expect(jwk[secret]).toBeUndefined();
    }
  });
});

describe("buildKeyring", () => {
  it("signs with the current key and publishes the kid that verifies it (AC1)", () => {
    const ring = buildKeyring({ privateKey: current.privateKey, publicKey: current.publicKey });
    const token = signJwt({ iat: 0, exp: 2 ** 31 }, ring.signing);
    const kid = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString()).kid;

    expect(ring.jwks.map((k) => k.kid)).toContain(kid);
    expect(verifyJwt(token, ring.verification, 1000).exp).toBe(2 ** 31);
  });

  it("keeps verifying tokens signed by the retired key during a rotation (AC8)", () => {
    const before = buildKeyring({
      privateKey: previous.privateKey,
      publicKey: previous.publicKey,
    });
    const liveToken = signJwt({ iat: 0, exp: 2 ** 31 }, before.signing);

    const after = buildKeyring({
      privateKey: current.privateKey,
      publicKey: current.publicKey,
      previousPublicKey: previous.publicKey,
    });

    expect(after.jwks).toHaveLength(2);
    // Current key first: a client that reads only the head of the list is right.
    expect(after.jwks[0].kid).toBe(after.signing.kid);
    expect(verifyJwt(liveToken, after.verification, 1000).exp).toBe(2 ** 31);

    // ...and once the previous key is dropped from the config, that token dies.
    const afterwards = buildKeyring({
      privateKey: current.privateKey,
      publicKey: current.publicKey,
    });
    expect(() => verifyJwt(liveToken, afterwards.verification, 1000)).toThrow();
  });

  it("does not publish the same key twice when previous == current", () => {
    const ring = buildKeyring({
      privateKey: current.privateKey,
      publicKey: current.publicKey,
      previousPublicKey: current.publicKey,
    });
    expect(ring.jwks).toHaveLength(1);
    expect(ring.verification.size).toBe(1);
  });
});
