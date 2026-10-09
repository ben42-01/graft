import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { coerceIds, redact } from "./support";

describe("redact", () => {
  it("replaces secret-named fields at any depth", () => {
    const out = redact({
      email: "a@b.c",
      passwordHash: "$argon2id$…",
      sessions: [{ tokenHash: "abc", familyId: "f1" }],
      stripe: { apiKey: "sk_live_x", nested: { webhookSecret: "whsec_x" } },
      accessToken: "eyJ…",
    }) as Record<string, unknown>;
    expect(out).toEqual({
      email: "a@b.c",
      passwordHash: "[redacted]",
      sessions: [{ tokenHash: "[redacted]", familyId: "f1" }],
      stripe: { apiKey: "[redacted]", nested: { webhookSecret: "[redacted]" } },
      accessToken: "[redacted]",
    });
  });

  it("keeps collection names that merely contain 'token' (counts)", () => {
    expect(redact({ refresh_tokens: "105", email_verification_tokens: "2" })).toEqual({
      refresh_tokens: "105",
      email_verification_tokens: "2",
    });
  });

  it("leaves ObjectIds and Dates intact", () => {
    const id = new ObjectId();
    const at = new Date();
    expect(redact({ _id: id, at })).toEqual({ _id: id, at });
  });
});

describe("coerceIds", () => {
  const hex = "6ac0a595930481e581e81f7e";

  it("turns 24-hex strings under _id and *Id keys into ObjectIds", () => {
    const out = coerceIds({ _id: hex, tenantId: hex, status: hex }) as Record<string, unknown>;
    expect(out._id).toBeInstanceOf(ObjectId);
    expect(out.tenantId).toBeInstanceOf(ObjectId);
    expect(out.status).toBe(hex);
  });

  it("coerces inside operators, keeping the field the operator sits under", () => {
    const out = coerceIds({ tenantId: { $in: [hex, hex] } }) as {
      tenantId: { $in: unknown[] };
    };
    expect(out.tenantId.$in.every((v) => v instanceof ObjectId)).toBe(true);
  });

  it.each(["$where", "$function", "$accumulator", "$expr"])(
    "refuses %s anywhere in a filter",
    (op) => {
      expect(() => coerceIds({ $and: [{ [op]: "1" }] })).toThrow(/not allowed/);
    },
  );
});
