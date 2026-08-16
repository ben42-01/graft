import { afterEach, describe, expect, it, vi } from "vitest";
import { REDACTED, createLogger, log, redact, redactErrorMessage } from "./log";

/** Captures what the logger actually writes, which is what AC7 is about. */
function captureLogs() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
    lines.push(line);
  });
  return { lines, restore: () => spy.mockRestore() };
}

afterEach(() => vi.restoreAllMocks());

// AC7 — the log serialiser over a document containing email and phone.
describe("redact", () => {
  const customer = {
    _id: "000000000000000000000041",
    tenantId: "000000000000000000000001",
    email: "ada@qa-free.test",
    phone: "+353 1 000 0001",
    name: "Ada Lovelace",
  };

  it("redacts direct PII fields", () => {
    expect(redact(customer)).toEqual({
      _id: "000000000000000000000041",
      tenantId: "000000000000000000000001",
      email: REDACTED,
      phone: REDACTED,
      name: REDACTED,
    });
  });

  it("redacts PII nested inside a record document", () => {
    const serialised = JSON.stringify(redact({ record: { data: customer } }));
    expect(serialised).not.toContain("ada@qa-free.test");
    expect(serialised).not.toContain("000 0001");
    expect(serialised).not.toContain("Ada Lovelace");
  });

  it("redacts a tenant payload wholesale — dynamic entity fields are unknowable", () => {
    expect(redact({ data: { whatever_the_tenant_called_it: "ada@qa-free.test" } })).toEqual({
      data: REDACTED,
    });
  });

  it("redacts credentials and tokens", () => {
    expect(redact({ password: "hunter2", authorization: "Bearer abc.def" })).toEqual({
      password: REDACTED,
      authorization: REDACTED,
    });
  });

  it("redacts an email even under an innocent key name", () => {
    expect(JSON.stringify(redact({ note: "ping ada@qa-free.test about it" }))).not.toContain(
      "ada@qa-free.test",
    );
  });

  it("keeps the correlation fields the checklist allows", () => {
    const fields = { requestId: "r-1", tenantId: "t-1", userId: "u-1", status: 200 };
    expect(redact(fields)).toEqual(fields);
  });

  it("survives cycles, dates and deep nesting without throwing", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => JSON.stringify(redact(cyclic))).not.toThrow();
    expect(redact(new Date("2026-01-15T12:00:00.000Z"))).toBe("2026-01-15T12:00:00.000Z");
  });
});

/**
 * GRAFT-02.1 AC4 (F4) — an Error kept `message` verbatim and redactString matched
 * only e-mail addresses, so a Mongo E11000 wrote the duplicated value straight to
 * the log. This bites for real in GRAFT-06/07, where tenants define their own
 * unique indexes over arbitrary fields.
 */
describe("redact over driver errors (AC4)", () => {
  /** The shape the Mongo driver actually throws on a unique-index collision. */
  const duplicateKeyError = (detail: string) => {
    const error = new Error(
      `E11000 duplicate key error collection: graft.records index: tenant_phone_idx dup key: ${detail}`,
    );
    error.name = "MongoServerError";
    return error;
  };

  it("keeps no duplicated value from a unique-index collision", () => {
    const serialised = JSON.stringify(
      redact(
        duplicateKeyError(
          `{ tenantId: ObjectId('000000000000000000000001'), phone: "+353 1 000 0001" }`,
        ),
      ),
    );
    expect(serialised).not.toContain("+353 1 000 0001");
    expect(serialised).not.toContain("000 0001");
  });

  it("redacts whatever the tenant happened to call the field", () => {
    for (const detail of [
      `{ tenant_vat_no: "IE1234567X" }`,
      `{ contact: "ada@qa-free.test" }`,
      `{ passport: 'P-99881122' }`,
      `{ mrn: 4455667788 }`,
    ]) {
      const serialised = JSON.stringify(redact(duplicateKeyError(detail)));
      expect(serialised, detail).not.toContain("IE1234567X");
      expect(serialised, detail).not.toContain("ada@qa-free.test");
      expect(serialised, detail).not.toContain("P-99881122");
      expect(serialised, detail).not.toContain("4455667788");
    }
  });

  it("keeps enough of the error to diagnose it", () => {
    const entry = redact(duplicateKeyError(`{ phone: "+353 1 000 0001" }`)) as Record<
      string,
      unknown
    >;
    expect(entry.name).toBe("MongoServerError");
    expect(String(entry.message)).toContain("E11000");
    expect(String(entry.message)).toContain(REDACTED);
  });

  it("still redacts a bare e-mail in any other error message", () => {
    const serialised = JSON.stringify(redact(new Error("could not notify ada@qa-free.test")));
    expect(serialised).not.toContain("ada@qa-free.test");
  });

  /**
   * Asserting the *exact* output, not just the absence of the secret. Absence
   * alone let a real defect through review: three of the four value rules have no
   * capture group, and a shared replacer function received the match offset in the
   * group position and spliced it into the line —
   * `connect ECONNREFUSED 21[redacted]:27017 for user 46[redacted]`. The line was
   * still safe, but it was also wrong, and `not.toContain` could never see it.
   */
  describe("writes exactly what it means to write", () => {
    const cases: readonly [string, string][] = [
      [
        `connect ECONNREFUSED 127.0.0.1:27017 for user "ada"`,
        `connect ECONNREFUSED ${REDACTED}:27017 for user ${REDACTED}`,
      ],
      [
        `E11000 duplicate key error collection: graft.records index: t_phone dup key: { phone: "+353 1 000 0001" }`,
        `E11000 duplicate key error collection: graft.records index: t_phone dup key: ${REDACTED}`,
      ],
      ["timeout after 30000ms", "timeout after 30000ms"],
      ["ETIMEDOUT", "ETIMEDOUT"],
    ];

    it.each(cases)("redacts %j exactly", (input, expected) => {
      expect(redactErrorMessage(input)).toBe(expected);
    });

    it("never splices a match offset into the message", () => {
      // Long enough that any offset would be a multi-digit number next to a marker.
      const message = `${"x".repeat(120)} secret "value" and another 'value'`;
      const out = redactErrorMessage(message);
      expect(out).toBe(`${"x".repeat(120)} secret ${REDACTED} and another ${REDACTED}`);
      expect(out).not.toMatch(/\d+\[redacted\]/);
    });
  });
});

/**
 * GRAFT-02.1 AC5 (F5) — `stack` and `cause` were dropped, while envelope.ts
 * promises the client "the log line has all of it". A 500 whose only record is a
 * one-line message is not diagnosable.
 */
describe("redact keeps a 500 diagnosable (AC5)", () => {
  it("keeps stack frames on the error", () => {
    const entry = redact(new Error("mongo timeout")) as Record<string, unknown>;
    expect(entry.stack).toBeDefined();
    expect(String(entry.stack)).toContain("log.test.ts");
  });

  it("keeps the cause chain", () => {
    const entry = redact(
      new Error("could not load tenant", { cause: new Error("ECONNREFUSED 127.0.0.1:27017") }),
    ) as Record<string, unknown>;
    const cause = entry.cause as Record<string, unknown>;
    expect(cause.message).toContain("ECONNREFUSED");
  });

  it("redacts PII in the stack and the cause too", () => {
    const inner = new Error('dup key: { phone: "+353 1 000 0001" }');
    const serialised = JSON.stringify(redact(new Error("write failed", { cause: inner })));
    expect(serialised).not.toContain("+353 1 000 0001");
  });

  // Stacks are long, so an offset splice would be a large number here — and this
  // is the field AC5 exists to preserve, so corrupting it defeats the point.
  it("keeps the stack readable rather than corrupting it", () => {
    const entry = redact(new Error('failed on "secret"')) as Record<string, unknown>;
    expect(String(entry.stack)).not.toMatch(/\d+\[redacted\]/);
    expect(String(entry.stack)).toContain("at ");
  });

  it("does not follow a cause chain forever", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as Error & { cause?: unknown }).cause = b;
    expect(() => JSON.stringify(redact(b))).not.toThrow();
  });
});

describe("log", () => {
  it("emits one JSON line with level, message and timestamp", () => {
    const { lines } = captureLogs();
    log("info", "request.complete", { requestId: "r-1", status: 200 });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({ level: "info", msg: "request.complete", requestId: "r-1" });
    expect(typeof entry.ts).toBe("string");
  });

  it("redacts fields on the way out", () => {
    const { lines } = captureLogs();
    log("warn", "submission.rejected", { email: "ada@qa-free.test" });
    expect(lines[0]).not.toContain("ada@qa-free.test");
    expect(JSON.parse(lines[0]).email).toBe(REDACTED);
  });
});

describe("createLogger", () => {
  it("binds fields onto every line", () => {
    const { lines } = captureLogs();
    const logger = createLogger({ requestId: "r-42", tenantId: "t-1" });
    logger.info("route.start");
    logger.error("route.failed", { code: "INTERNAL" });
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(JSON.parse(line).requestId).toBe("r-42");
    expect(JSON.parse(lines[1])).toMatchObject({ level: "error", code: "INTERNAL" });
  });
});
