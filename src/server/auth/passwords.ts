/**
 * Password hashing (GRAFT-03.2 AC4, AC8).
 * PROTECTED PATH (.github/agent-policy.yml: src/server/auth/**).
 *
 * argon2id, with the OWASP Password Storage Cheat Sheet's second recommended
 * configuration: 19 MiB of memory, two passes, one lane. Memory-hard by design —
 * that is the entire point of choosing argon2id over bcrypt here, because the
 * attacker's advantage in a GPU array is bounded by RAM rather than by clock.
 *
 * Two rules this module exists to enforce:
 *
 *   1. A hash never leaves this file's callers as a value anyone can compare
 *      against. `verifyPassword` is the only comparison, and it is constant-work.
 *   2. **A missing hash costs the same as a wrong one** (AC8). `verifyPassword`
 *      accepts null and still performs a real argon2 verification against a
 *      reference digest. If the enumeration defence lived in the caller instead,
 *      it would be one forgotten early-return away from being gone — here the
 *      caller cannot skip it, because there is no faster path to skip to.
 */
import { hash, verify } from "@node-rs/argon2";
import { z } from "zod";

/**
 * NIST SP 800-63B: length is the control that matters, composition rules are
 * not. The cap is a denial-of-service guard, not a security opinion — argon2 is
 * deliberately expensive and the input is attacker-controlled.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`);

/**
 * `Algorithm.Argon2id` is an ambient const enum, which `isolatedModules` cannot
 * read across the module boundary. Its value is 2 and is part of argon2's own
 * wire format, so it is pinned here with the assertion that keeps it honest
 * (see passwords.test.ts — every digest must start `$argon2id$`).
 */
const ARGON2ID = 2;

const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456, // KiB
  timeCost: 2,
  parallelism: 1,
} as const;

export const hashPassword = (plain: string): Promise<string> => hash(plain, OPTIONS);

/**
 * The reference digest for the no-such-user path. Computed once, lazily, and
 * never compared against anything a caller supplied — it exists only so the
 * unknown-email branch does the same work as the wrong-password branch.
 */
let referenceHash: Promise<string> | null = null;
const reference = () => (referenceHash ??= hashPassword("graft.enumeration.defence"));

export async function verifyPassword(
  storedHash: string | null | undefined,
  plain: string,
): Promise<boolean> {
  const digest = storedHash || (await reference());
  try {
    const matched = await verify(digest, plain, OPTIONS);
    // A match against the reference digest is still not a login.
    return storedHash ? matched : false;
  } catch {
    // A corrupt or foreign digest is a failed login, not a 500. The work has
    // already been done by this point, so returning here costs nothing timing-wise.
    return false;
  }
}
