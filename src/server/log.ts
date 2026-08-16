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
  { pattern: /'[^']*'/g, replacement: REDACTED },
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

function redactError(error: Error, causeDepth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: error.name,
    message: redactErrorMessage(error.message),
  };
  const stack = redactStack(error.stack);
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
