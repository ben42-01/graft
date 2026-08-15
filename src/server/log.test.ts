import { afterEach, describe, expect, it, vi } from "vitest";
import { REDACTED, createLogger, log, redact } from "./log";

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
