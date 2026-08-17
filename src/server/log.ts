/**
 * Structured logging (docs/BACKEND.md §1.5, .github/agent-policy.yml security
 * checklist: "No PII in logs; requestId + tenantId + userId only").
 *
 * One JSON object per line, and everything on its way out goes through
 * `redact()`. The deny-list is deliberately blunt: Graft's records are
 * tenant-defined, so any field a tenant named is potentially personal data and
 * whole payloads are dropped rather than sampled. A log line is for correlation
 * — requestId, tenantId, userId, route, status — not for inspecting data.
 *
 * Driver errors are the one place that used to need prose parsing; they are now
 * logged from their structured fields instead, as `error.driver` (GRAFT-17, see
 * `driverSummary`). The regex fallback below remains for errors that carry no
 * structure at all.
 *
 * Console-based rather than pino: the line format is the contract, the writer is
 * an implementation detail, and Vercel/Docker both collect stdout.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export const REDACTED = "[redacted]";

/** Keys whose *value* is personal data wherever it appears. */
const PII_KEYS = new Set([
  "email",
  "emails",
  "phone",
  "phonenumber",
  "mobile",
  "name",
  "firstname",
  "lastname",
  "fullname",
  "address",
  "street",
  "city",
  "postcode",
  "zip",
  "dob",
  "dateofbirth",
  "ssn",
  "pps",
  "vat",
  "iban",
  "card",
  "password",
  "passwordhash",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "authorization",
  "cookie",
  "ip",
  "ipaddress",
  "useragent",
]);

/** Keys that hold tenant-defined content — dropped wholesale, never walked. */
const PAYLOAD_KEYS = new Set([
  "data",
  "body",
  "payload",
  "doc",
  "document",
  "record",
  "records",
  "fields",
  "values",
  "submission",
]);

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const MAX_DEPTH = 4;
const MAX_ARRAY = 20;
/** Stack frames are for diagnosis, not forensics — the top of the stack is the bug. */
const MAX_STACK_FRAMES = 12;
const MAX_CAUSE_DEPTH = 4;

function redactString(value: string): string {
  return EMAIL_PATTERN.test(value) ? REDACTED : value;
}

/**
 * Driver error text carries data (GRAFT-02.1 AC4). Mongo's E11000 quotes the
 * duplicated value back at you:
 *
 *   E11000 duplicate key error collection: graft.records index: tenant_phone_idx
 *   dup key: { tenantId: ObjectId('…'), phone: "+353 1 000 0001" }
 *
 * and in GRAFT-06/07 the indexed field is whatever the tenant named it, so no
 * key-based deny-list can anticipate it. Everything that looks like a value is
 * dropped and the diagnostic skeleton — error class, index name, code — is kept.
 */
/**
 * Each rule carries its own replacement string rather than sharing one replacer
 * function. A shared `(match, group) => …` is a trap here: `String.replace`
 * passes the match *offset* in that position for any pattern without a capture
 * group, so the offset gets spliced into the message
 * (`ECONNREFUSED 21[redacted]:27017`). Replacement strings have no such
 * ambiguity, and `REDACTED` contains no `$` to be re-interpreted.
 */
const VALUE_RULES: readonly { pattern: RegExp; replacement: string }[] = [
  // The whole `dup key: { … }` clause, which is nothing but values. The prefix is
  // captured and put back, so the line still says *what kind* of failure it was.
  { pattern: /(dup key:\s*)\{[^}]*\}/gi, replacement: `$1${REDACTED}` },
  // Anything quoted, in either quote style, including inside ObjectId('…').
  { pattern: /"[^"]*"/g, replacement: REDACTED },
  // The opening quote must follow a non-word character. Apostrophes are
  // ambiguous: a contraction supplies an unmatched quote, and a naive
  // /'[^']*'/g then pairs them off by one, so the redacted span slides onto the
  // diagnostic text while the value walks free — `doesn't match index 'idx' for
  // value 'IE1234567X'` redacted to `doesn[redacted]idx[redacted]IE1234567X'`.
  // Under-redacting while printing "[redacted]" is worse than not redacting:
  // it looks handled. Real driver texts do this ("Can't extract geo keys").
  { pattern: /(^|[^\w])'[^']*'/g, replacement: `$1${REDACTED}` },
  // Bare runs of digits long enough to be an identifier, a phone or an account.
  // Short runs survive on purpose: "timeout after 30000ms" stays diagnosable.
  { pattern: /\b\d[\d\s().+-]{5,}\d\b/g, replacement: REDACTED },
];

export function redactErrorMessage(message: string): string {
  let out = message;
  for (const { pattern, replacement } of VALUE_RULES) {
    out = out.replace(pattern, replacement);
  }
  // A bare address that survived the value rules (unquoted, unbracketed).
  return EMAIL_PATTERN.test(out) ? out.replace(new RegExp(EMAIL_PATTERN, "g"), REDACTED) : out;
}

/**
 * GRAFT-17 — the structured half of the same defence.
 *
 * The regexes above pair quotes over natural-language prose, which has no stable
 * boundary: each tightening in #24 moved the failure rather than removing it
 * (an offset spliced into the line, then a contraction sliding the redacted span
 * onto the diagnostic text while the value walked free). The driver already hands
 * us the same facts as fields, so on that path nothing is parsed at all.
 *
 * A `MongoServerError` for a unique-index collision carries:
 *
 *   code: 11000, codeName: "DuplicateKey", index: "tenant_vat_idx",
 *   keyPattern: { tenantId: 1, vat_no: 1 },
 *   keyValue:   { tenantId: ObjectId('…'), vat_no: "IE1234567X" }   ← data
 *
 * `keyPattern`'s *keys* are the index definition — schema, safe, and exactly what
 * you need to know which constraint failed. `keyValue` and the direction values
 * are never read. Duck-typed on the fields rather than on `name`, so
 * `MongoBulkWriteError` and friends take the same path.
 *
 * Two corrections to what the contract assumed, both verified against the driver
 * (mongodb 6.x) rather than a fixture, which is why AC4 is an integration test:
 *
 *  - `error.index` is **not** the index name. It is the operation's offset within
 *    the write batch — `0` for a plain `insertOne` — so it is logged as `opIndex`.
 *    Calling that field `index` in a log line would read as "an index named 0".
 *  - the index *name* is the one fact carried only in the message, so it is lifted
 *    out of it (see `indexNameFrom`).
 *
 * The error also carries `errorResponse` — a second copy of the same fields,
 * `keyValue` included — and a bulk write's `writeErrors[].err.op` is the whole
 * document being written. Neither is ever read: `redactError` builds its output
 * from an explicit list, so a new driver field cannot appear in a log line by
 * default.
 */
const MAX_KEY_NAMES = 20;
const MAX_WRITE_ERRORS = 5;

/**
 * Index names, and only index names. No quotes, no spaces, no `@`, length-capped:
 * a duplicated *value* cannot pass this even if it somehow reached the slot.
 */
const INDEX_NAME_SHAPE = /^[\w.$-]{1,120}$/;
/**
 * The name sits between two literal markers the server itself writes:
 * `… index: tenant_vat_idx dup key: { … }`. Nothing is load-bearing on this match
 * — a miss omits the field, so the failure mode is a missing diagnostic, never a
 * leak, which is exactly what the prose-redaction approach could not promise.
 */
const INDEX_NAME_PATTERN = /\bindex:\s*([\w.$-]{1,120})\s+dup key:/i;

function indexNameLike(value: unknown): string | undefined {
  return typeof value === "string" && INDEX_NAME_SHAPE.test(value) ? value : undefined;
}

function indexNameFrom(message: unknown): string | undefined {
  if (typeof message !== "string") return undefined;
  return indexNameLike(INDEX_NAME_PATTERN.exec(message)?.[1]);
}

/** Index names and codes only — never a value, so the surface is deliberately tiny. */
function driverScalar(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // An index or code name is schema, but it is still a string from the wire.
  if (typeof value === "string" && value.length <= 200) return redactString(value);
  return undefined;
}

/** The key *names* of an index definition. Values are not touched. */
function indexKeyNames(keyPattern: unknown): string[] | undefined {
  if (keyPattern === null || typeof keyPattern !== "object" || Array.isArray(keyPattern)) {
    return undefined;
  }
  const names = Object.keys(keyPattern as Record<string, unknown>).slice(0, MAX_KEY_NAMES);
  return names.length > 0 ? names : undefined;
}

type DriverFacts = {
  code?: string | number;
  /** The index name — schema, never data. */
  index?: string;
  /** Position of the failing operation in the write batch. */
  opIndex?: number;
  keys?: string[];
};

/**
 * The fields shared by an error and by one entry of a bulk write's `writeErrors`.
 * A bulk entry nests them under `err`, so both levels are read, `err` winning.
 * `errmsg` is the per-entry message: consulted for the index name, never logged.
 */
function factsFrom(source: Record<string, unknown>, message: unknown): DriverFacts {
  const facts: DriverFacts = {};
  const code = driverScalar(source.code);
  if (code !== undefined) facts.code = code;
  // A string here would be a name, a number the batch offset. Real drivers send
  // the number; the string branch costs one line and survives a rename.
  const index = indexNameLike(source.index) ?? indexNameFrom(message);
  if (index !== undefined) facts.index = index;
  if (typeof source.index === "number" && Number.isFinite(source.index)) {
    facts.opIndex = source.index;
  }
  const keys = indexKeyNames(source.keyPattern);
  if (keys) facts.keys = keys;
  return facts;
}

function writeErrorFacts(entry: unknown): DriverFacts | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  const own = entry as Record<string, unknown>;
  const nested =
    own.err !== null && typeof own.err === "object" ? (own.err as Record<string, unknown>) : {};
  const facts = factsFrom({ ...own, ...nested }, nested.errmsg ?? own.errmsg);
  return Object.keys(facts).length > 0 ? facts : undefined;
}

type DriverSummary = { fields: Record<string, unknown>; identifiesKey: boolean };

function driverSummary(error: Error): DriverSummary | undefined {
  const source = error as unknown as Record<string, unknown>;
  const facts = factsFrom(source, error.message);
  const codeName = driverScalar(source.codeName);
  const fields: Record<string, unknown> = { ...facts };
  if (codeName !== undefined) fields.codeName = codeName;

  const writeErrors = Array.isArray(source.writeErrors)
    ? source.writeErrors
        .slice(0, MAX_WRITE_ERRORS)
        .map(writeErrorFacts)
        .filter((entry): entry is DriverFacts => entry !== undefined)
    : [];
  if (writeErrors.length > 0) fields.writeErrors = writeErrors;

  if (Object.keys(fields).length === 0) return undefined;
  // The message may be dropped only when the structure says which key failed —
  // a bare `code` does not, and dropping the prose there would cost diagnosis
  // for nothing. A bulk write is the honest gap: the server reports no
  // `keyPattern` per entry, so those keep the redacted message (AC3's fallback).
  // Nothing in src/ writes in bulk today; if that changes, the collision path
  // should carry its own key names rather than lean on the regexes again.
  const identifiesKey =
    facts.keys !== undefined || writeErrors.some((entry) => entry.keys !== undefined);
  return { fields, identifiesKey };
}

/**
 * The stack is kept (GRAFT-02.1 AC5) because envelope.ts tells the client
 * "the log line has all of it" — a 500 whose only record is one line is not
 * diagnosable. Frames are paths and function names, but the first line repeats
 * the message, so the whole thing goes through the same redaction.
 */
function redactStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  return redactErrorMessage(
    stack
      .split("\n")
      .slice(0, MAX_STACK_FRAMES + 1)
      .join("\n"),
  );
}

/**
 * The head of a stack is the message repeated, so a path that drops the message
 * must drop it here too — otherwise AC2 is satisfied in one field and defeated in
 * the next. Frames alone still identify the failing call site, which is what AC5
 * wanted the stack for. Redaction stays applied to them: cheap, and a frame can
 * carry an argument in some runtimes.
 */
function redactStackFrames(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const lines = stack.split("\n");
  const first = lines.findIndex((line) => /^\s+at /.test(line));
  if (first === -1) return undefined;
  return redactErrorMessage(lines.slice(first, first + MAX_STACK_FRAMES).join("\n"));
}

function redactError(error: Error, causeDepth: number): Record<string, unknown> {
  const driver = driverSummary(error);
  const out: Record<string, unknown> = { name: error.name };
  if (driver) out.driver = driver.fields;
  // With the failing key named structurally, the free-form message is redundant
  // *and* the only remaining exposure — so it does not reach the line at all.
  if (!driver?.identifiesKey) out.message = redactErrorMessage(error.message);

  const stack = driver?.identifiesKey
    ? redactStackFrames(error.stack)
    : redactStack(error.stack);
  if (stack) out.stack = stack;

  const { cause } = error;
  if (cause !== undefined && causeDepth < MAX_CAUSE_DEPTH) {
    out.cause =
      cause instanceof Error
        ? redactError(cause, causeDepth + 1)
        : redact(cause, MAX_DEPTH - 1, new WeakSet());
  }
  return out;
}

/**
 * Recursive, total, and never throws: a logger that can crash a request is
 * worse than no logger. Cycles, class instances and oversized structures are
 * all reduced rather than followed.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return "[unloggable]";
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return redactError(value, 0);

  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    if (depth >= MAX_DEPTH) return "[truncated]";
    seen.add(value);

    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY).map((item) => redact(item, depth + 1, seen));
      return value.length > MAX_ARRAY
        ? [...items, `[+${value.length - MAX_ARRAY} more]`]
        : items;
    }

    const source = value as Record<string, unknown>;
    // Anything that is not a plain object (ObjectId, Buffer, a driver cursor)
    // gets stringified rather than walked field by field.
    const proto = Object.getPrototypeOf(source);
    if (proto !== Object.prototype && proto !== null) return String(source);

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      const normalised = key.toLowerCase();
      if (PII_KEYS.has(normalised) || PAYLOAD_KEYS.has(normalised)) out[key] = REDACTED;
      else out[key] = redact(item, depth + 1, seen);
    }
    return out;
  }
  return "[unloggable]";
}

export function log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(redact(fields ?? {}) as Record<string, unknown>),
  };
  console.log(JSON.stringify(line));
}

export type Logger = {
  debug: (message: string, fields?: Record<string, unknown>) => void;
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
  child: (bindings: Record<string, unknown>) => Logger;
};

/** A logger with `requestId` (and later tenantId/userId) bound to every line. */
export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  const at = (level: LogLevel) => (message: string, fields?: Record<string, unknown>) =>
    log(level, message, { ...bindings, ...fields });
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  };
}
