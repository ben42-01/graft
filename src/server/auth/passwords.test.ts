/**
 * AC4 + AC8 — password storage and the timing property that stops enumeration.
 */
import { describe, expect, it } from "vitest";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  hashPassword,
  passwordSchema,
  verifyPassword,
} from "./passwords";

const PASSWORD = "correct horse battery staple";

describe("hashPassword", () => {
  it("AC4 — produces an argon2id digest, never the password", async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).not.toContain(PASSWORD);
  });

  it("salts, so the same password never hashes to the same string twice", async () => {
    expect(await hashPassword(PASSWORD)).not.toEqual(await hashPassword(PASSWORD));
  });
});

describe("verifyPassword", () => {
  it("accepts the right password and rejects the wrong one", async () => {
    const hash = await hashPassword(PASSWORD);
    expect(await verifyPassword(hash, PASSWORD)).toBe(true);
    expect(await verifyPassword(hash, "wrong horse battery staple")).toBe(false);
  });

  it("AC8 — a missing hash still costs a verification, and returns false", async () => {
    // The unknown-email path calls this with null. If it short-circuited, the
    // response time would tell an attacker the address is unregistered.
    expect(await verifyPassword(null, PASSWORD)).toBe(false);
    expect(await verifyPassword(undefined, PASSWORD)).toBe(false);
  });

  it("AC8 — unknown-email and wrong-password land in the same timing class", async () => {
    const hash = await hashPassword(PASSWORD);
    const time = async (run: () => Promise<unknown>) => {
      const started = process.hrtime.bigint();
      await run();
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    // Warm the allocator so the first call does not skew the comparison.
    await verifyPassword(hash, "warmup");

    const wrongPassword = await time(() => verifyPassword(hash, "wrong"));
    const unknownEmail = await time(() => verifyPassword(null, "wrong"));

    // "Same timing class", not "same duration": the assertion is that the null
    // path does real argon2 work, so it cannot be an order of magnitude faster.
    expect(unknownEmail).toBeGreaterThan(wrongPassword / 4);
  });

  it("returns false rather than throwing on a corrupt stored hash", async () => {
    expect(await verifyPassword("not-a-hash", PASSWORD)).toBe(false);
  });
});

describe("passwordSchema", () => {
  it("rejects passwords below the minimum length", () => {
    expect(passwordSchema.safeParse("a".repeat(PASSWORD_MIN_LENGTH - 1)).success).toBe(false);
    expect(passwordSchema.safeParse("a".repeat(PASSWORD_MIN_LENGTH)).success).toBe(true);
  });

  it("caps length — an unbounded password is an argon2 denial of service", () => {
    expect(passwordSchema.safeParse("a".repeat(PASSWORD_MAX_LENGTH + 1)).success).toBe(false);
  });
});
