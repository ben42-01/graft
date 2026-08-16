/**
 * RS256 sign/verify, hand-rolled on node:crypto (docs/BACKEND.md §3.1, §9 —
 * "hand-rolled RS256 exactly as specified in §3.1 — no Auth.js, no Clerk").
 *
 * PROTECTED PATH (.github/agent-policy.yml: src/server/auth/**).
 *
 * Deliberately tiny and deliberately paranoid. The rules that make a hand-rolled
 * verifier safe rather than a liability:
 *
 *   1. `alg` is never read from the token to choose the algorithm. It is
 *      compared against the one algorithm we accept. This is the "alg: none" and
 *      RS256→HS256 confusion class of bug, and it is closed by construction.
 *   2. `kid` selects a key from a fixed set we published. An unknown kid is a
 *      rejection, never a fallback to "try them all with no kid".
 *   3. The signature is verified before a single claim is trusted.
 *   4. Every failure raises the same UNAUTHORIZED with the same message. Which
 *      check failed is information an attacker can grind against; it goes to the
 *      log, never to the client.
 */
import { createPublicKey, createPrivateKey, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { AppError } from "@/server/http/envelope";

export const ALG = "RS256" as const;

/** Tolerance for clock drift between the signer and the verifier, in seconds. */
export const CLOCK_SKEW_SECONDS = 30;

export type JwtHeader = { alg: string; typ: string; kid: string };

/** Registered claims this module understands; the payload may carry more. */
export type JwtClaims = { iat: number; exp: number } & Record<string, unknown>;

/** One message for every rejection — see rule 4 above. */
const reject = (): never => {
  throw new AppError("UNAUTHORIZED", "Invalid or expired token");
};

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return reject();
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function signJwt(
  claims: Record<string, unknown>,
  key: { kid: string; privateKey: KeyObject },
): string {
  const header: JwtHeader = { alg: ALG, typ: "JWT", kid: key.kid };
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature = sign("sha256", Buffer.from(signingInput), key.privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

/**
 * Verifies signature first, then time. `keys` is the set of public keys we
 * currently publish (current + previous, AC8), keyed by kid.
 */
export function verifyJwt(
  token: string,
  keys: ReadonlyMap<string, KeyObject>,
  now: number = Date.now(),
): JwtClaims {
  const parts = token.split(".");
  if (parts.length !== 3) return reject();
  const [headerPart, payloadPart, signaturePart] = parts;

  const header = decodeSegment(headerPart);
  if (!isObject(header)) return reject();
  // Rule 1 — our algorithm, not the token's.
  if (header.alg !== ALG || typeof header.kid !== "string") return reject();

  // Rule 2 — a kid we published, or nothing.
  const publicKey = keys.get(header.kid);
  if (!publicKey) return reject();

  // Rule 3 — signature before claims.
  const ok = verify(
    "sha256",
    Buffer.from(`${headerPart}.${payloadPart}`),
    publicKey,
    Buffer.from(signaturePart, "base64url"),
  );
  if (!ok) return reject();

  const claims = decodeSegment(payloadPart);
  if (!isObject(claims)) return reject();
  if (typeof claims.exp !== "number" || typeof claims.iat !== "number") return reject();

  const seconds = Math.floor(now / 1000);
  if (claims.exp + CLOCK_SKEW_SECONDS <= seconds) return reject();
  // A token from the future is either a clock problem or a forgery attempt.
  if (claims.iat - CLOCK_SKEW_SECONDS > seconds) return reject();

  return claims as JwtClaims;
}

/** Re-exported so callers never import node:crypto to build a key. */
export const publicKeyFromPem = (pem: string): KeyObject => createPublicKey(pem);
export const privateKeyFromPem = (pem: string): KeyObject => createPrivateKey(pem);
