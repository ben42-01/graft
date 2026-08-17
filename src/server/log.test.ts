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
      // Driver text with a contraction ahead of the value (see the exact-output
      // table): the apostrophe must not shift which span gets redacted.
      `{ vat: 'IE1234567X' } — can't apply`,
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
      // A contraction supplies an unmatched apostrophe. Pairing quotes off by
      // one slid the redaction onto the diagnostic text and let the value walk
      // free — printing "[redacted]" while leaking is worse than not redacting.
      [
        `doesn't match index 'tenant_vat_idx' for value 'IE1234567X'`,
        `doesn't match index ${REDACTED} for value ${REDACTED}`,
      ],
      [
        `Can't extract geo keys: { loc: 'Dublin 2' } wrong type`,
        `Can't extract geo keys: { loc: ${REDACTED} } wrong type`,
      ],
      [`'leading' then 'second'`, `${REDACTED} then ${REDACTED}`],
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
 * GRAFT-17 — the driver hands us the same information structurally, so the
 * E11000 path stops depending on quote-pairing over prose entirely. Assertions
 * here are on the *exact* object: `not.toContain` is what hid both #24 defects.
 */
describe("redact over structured driver errors (GRAFT-17)", () => {
  /**
   * The real shape of a `MongoServerError` on a unique-index collision: the
   * duplicated value appears twice, in `message` and in `keyValue`.
   */
  const serverError = (
    extra: Record<string, unknown>,
    message = "E11000 duplicate key error",
  ) => {
    const error = Object.assign(new Error(message), extra);
    error.name = "MongoServerError";
    return error;
  };

  /**
   * Faithful to what the driver actually throws, as verified in
   * log.integration.test.ts: `index` is the *batch offset* (0 for a single
   * insert), not the index name, and the name appears only in the message.
   */
  const dupKey = (field: string, value: unknown) =>
    serverError(
      {
        code: 11000,
        index: 0,
        keyPattern: { tenantId: 1, [field]: 1 },
        keyValue: { tenantId: "000000000000000000000001", [field]: value },
      },
      `E11000 duplicate key error collection: graft.records index: tenant_${field}_idx dup key: { tenantId: ObjectId('000000000000000000000001'), ${field}: "${String(value)}" }`,
    );

  // AC1 — code, index and the key *names*; never a value, from keyValue or anywhere.
  it("logs the structured fields and no values at all", () => {
    const entry = redact(dupKey("vat_no", "IE1234567X")) as Record<string, unknown>;
    expect(entry.name).toBe("MongoServerError");
    expect(entry.driver).toEqual({
      code: 11000,
      index: "tenant_vat_no_idx",
      opIndex: 0,
      keys: ["tenantId", "vat_no"],
    });
    expect(entry.keyValue).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain("IE1234567X");
  });

  it("keeps codeName when the server sends one", () => {
    const error = Object.assign(dupKey("iban", "IE29"), { codeName: "DuplicateKey" });
    expect((redact(error) as Record<string, unknown>).driver).toMatchObject({
      codeName: "DuplicateKey",
    });
  });

  /**
   * The index name is the one fact only the message carries, so it is lifted out
   * of it — between the server's own two markers, and only if it has the shape of
   * an index name. A value cannot pass that filter, and a miss omits the field.
   */
  it("extracts an index name only from the server's own slot", () => {
    const entry = redact(
      serverError(
        { code: 11000, index: 0, keyPattern: { vat: 1 } },
        `E11000 duplicate key error collection: graft.records index: "ada@qa-free.test" dup key: { vat: 'IE1234567X' }`,
      ),
    ) as Record<string, unknown>;
    // Quoted, so not index-name-shaped: the field is dropped rather than guessed.
    expect(entry.driver).toEqual({ code: 11000, opIndex: 0, keys: ["vat"] });
    expect(JSON.stringify(entry)).not.toContain("ada@qa-free.test");
  });

  // AC2 — with keyPattern present the free-form message never reaches the line,
  // so no regex is load-bearing on this path.
  it("drops the message entirely when structure is available", () => {
    const entry = redact(dupKey("passport", "P-99881122")) as Record<string, unknown>;
    expect(entry.message).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain("E11000 duplicate key error collection");
    expect(JSON.stringify(entry)).not.toContain("dup key");
  });

  // The residuals #24 accepted (`foo'x'`, unanchored double quotes) are simply
  // unreachable here: the prose is never consulted.
  it("leaks nothing from message shapes the regexes could not reach", () => {
    for (const value of ["IE1234567X", "ada@qa-free.test", "+353 1 000 0001", 4455667788]) {
      const entry = redact(dupKey("whatever_the_tenant_called_it", value));
      const serialised = JSON.stringify(entry);
      expect(serialised, String(value)).not.toContain(String(value));
      expect(serialised, String(value)).toContain("whatever_the_tenant_called_it");
    }
  });

  /**
   * A bulk write's real shape: fields under `err`, and `err.op` is the entire
   * document being written — the largest single lump of tenant data on the error.
   * It must not appear, and it cannot, because the output is an explicit list.
   */
  it("reads the write-error array a bulk write reports and never its op document", () => {
    const entry = redact(
      serverError({
        code: 11000,
        writeErrors: [
          {
            err: {
              index: 0,
              code: 11000,
              errmsg: `E11000 duplicate key error collection: graft.records index: tenant_email_idx dup key: { email: "ada@qa-free.test" }`,
              op: { tenantId: "000000000000000000000001", data: { email: "ada@qa-free.test" } },
            },
          },
          { code: 11000, index: 1, keyPattern: { mrn: 1 }, keyValue: { mrn: "MRN-4455" } },
        ],
      }),
    ) as Record<string, unknown>;
    expect((entry.driver as Record<string, unknown>).writeErrors).toEqual([
      { code: 11000, index: "tenant_email_idx", opIndex: 0 },
      { code: 11000, opIndex: 1, keys: ["mrn"] },
    ]);
    const serialised = JSON.stringify(entry);
    expect(serialised).not.toContain("ada@qa-free.test");
    expect(serialised).not.toContain("MRN-4455");
  });

  // AC5 — structuring must not undo GRAFT-02.1 AC5. Frames survive; the message
  // line at the head of the stack does not, because it is the prose again.
  it("keeps the stack frames but not the message line inside them", () => {
    const entry = redact(dupKey("phone", "+353 1 000 0001")) as Record<string, unknown>;
    expect(String(entry.stack)).toContain("log.test.ts");
    expect(String(entry.stack)).not.toContain("E11000");
    expect(
      String(entry.stack)
        .split("\n")
        .every((line) => /^\s+at /.test(line)),
    ).toBe(true);
  });

  it("structures a driver error found on the cause chain", () => {
    const entry = redact(
      new Error("could not save record", { cause: dupKey("iban", "IE29AIBK93115212345678") }),
    ) as Record<string, unknown>;
    const cause = entry.cause as Record<string, unknown>;
    expect(cause.driver).toEqual({
      code: 11000,
      index: "tenant_iban_idx",
      opIndex: 0,
      keys: ["tenantId", "iban"],
    });
    expect(cause.message).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain("IE29AIBK93115212345678");
  });

  // AC3 — no structured fields, no change: the fallback is still the regex path.
  it("falls back to the redacted message when the error carries no structure", () => {
    const entry = redact(
      serverError({}, `E11000 duplicate key error dup key: { phone: "+353 1 000 0001" }`),
    ) as Record<string, unknown>;
    expect(entry.driver).toBeUndefined();
    expect(entry.message).toBe(`E11000 duplicate key error dup key: ${REDACTED}`);
    expect(String(entry.stack)).toContain("MongoServerError");
  });

  // `code` alone does not identify a key, so the message is still the only
  // diagnosis available and is kept — redacted, exactly as before.
  it("keeps the redacted message when only a code is present", () => {
    const entry = redact(
      serverError({ code: 91 }, `shutdown in progress for "primary"`),
    ) as Record<string, unknown>;
    expect(entry.driver).toEqual({ code: 91 });
    expect(entry.message).toBe(`shutdown in progress for ${REDACTED}`);
  });

  it("copies key names out rather than passing keyPattern through", () => {
    const entry = redact(dupKey("email", "ada@qa-free.test")) as Record<string, unknown>;
    const driver = entry.driver as Record<string, unknown>;
    expect(driver.keys).toEqual(["tenantId", "email"]);
    // The container itself never reaches the line — only names lifted out of it.
    expect(driver.keyPattern).toBeUndefined();
    expect(driver.keyValue).toBeUndefined();
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
