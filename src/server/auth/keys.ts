/**
 * The signing keyring (docs/BACKEND.md §3.1 — "key rotation via JWKS endpoint;
 * kid in header"). PROTECTED PATH (.github/agent-policy.yml).
 *
 * The private key is read from disk into a KeyObject once and never leaves this
 * process: nothing here returns, serialises or logs it, and `jwks()` derives its
 * output from the *public* key only. `npm run setup` generates the pair into
 * .keys/, which is gitignored (docs/WORKFLOW.md §4.3).
 *
 * Rotation (AC8): set JWT_PREVIOUS_PUBLIC_KEY_PATH to the key being retired.
 * New tokens are signed with the current key; tokens already in the wild keep
 * verifying against the previous one until they expire, 15 minutes later.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { KeyObject } from "node:crypto";
import { env } from "@/env";
import { privateKeyFromPem, publicKeyFromPem, ALG } from "./jwt";

export type Jwk = {
  kty: "RSA";
  use: "sig";
  alg: typeof ALG;
  kid: string;
  n: string;
  e: string;
};

export type Keyring = {
  /** The key new tokens are signed with. */
  signing: { kid: string; privateKey: KeyObject };
  /** Every key a token may legitimately have been signed with, by kid. */
  verification: ReadonlyMap<string, KeyObject>;
  /** The public half, in JWKS order: current key first. */
  jwks: Jwk[];
};

/**
 * RFC 7638 thumbprint. The kid is *derived* from the key rather than configured,
 * so it cannot drift out of step with the key it names — rotate the file and the
 * kid changes with it, which is exactly the property AC8 depends on.
 */
export function kidFor(publicKey: KeyObject): string {
  const { n, e } = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  const canonical = JSON.stringify({ e, kty: "RSA", n });
  return createHash("sha256").update(canonical).digest("base64url");
}

export function jwkFor(publicKey: KeyObject): Jwk {
  const { n, e } = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  // Explicit field list, not a spread of the export: `d`, `p`, `q` must never be
  // able to reach this object, even if this were handed a private key by mistake.
  return { kty: "RSA", use: "sig", alg: ALG, kid: kidFor(publicKey), n, e };
}

export function buildKeyring(pem: {
  privateKey: string;
  publicKey: string;
  previousPublicKey?: string;
}): Keyring {
  const publicKey = publicKeyFromPem(pem.publicKey);
  const kid = kidFor(publicKey);
  const verification = new Map<string, KeyObject>([[kid, publicKey]]);
  const jwks = [jwkFor(publicKey)];

  if (pem.previousPublicKey) {
    const previous = publicKeyFromPem(pem.previousPublicKey);
    const previousKid = kidFor(previous);
    if (previousKid !== kid) {
      verification.set(previousKid, previous);
      jwks.push(jwkFor(previous));
    }
  }

  return {
    signing: { kid, privateKey: privateKeyFromPem(pem.privateKey) },
    verification,
    jwks,
  };
}

let cached: Keyring | null = null;

/** Read once per process — a keypair is not something to re-read per request. */
export function keyring(): Keyring {
  if (cached) return cached;
  const { JWT_PRIVATE_KEY_PATH, JWT_PUBLIC_KEY_PATH, JWT_PREVIOUS_PUBLIC_KEY_PATH } = env();
  try {
    cached = buildKeyring({
      privateKey: readFileSync(JWT_PRIVATE_KEY_PATH, "utf8"),
      publicKey: readFileSync(JWT_PUBLIC_KEY_PATH, "utf8"),
      previousPublicKey: JWT_PREVIOUS_PUBLIC_KEY_PATH
        ? readFileSync(JWT_PREVIOUS_PUBLIC_KEY_PATH, "utf8")
        : undefined,
    });
  } catch (cause) {
    // The path is safe to name; the contents are not, and `cause` is dropped so
    // a PEM fragment can never ride out inside an error message.
    throw new Error(
      `Cannot load the JWT keypair from ${JWT_PRIVATE_KEY_PATH} / ${JWT_PUBLIC_KEY_PATH}. ` +
        `Run \`npm run setup\` to generate one. (${(cause as Error).name})`,
    );
  }
  return cached;
}

/** Test seam — the keyring is process-wide state and tests must not inherit it. */
export function resetKeyring(): void {
  cached = null;
}
