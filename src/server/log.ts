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

function redactString(value: string): string {
  return EMAIL_PATTERN.test(value) ? REDACTED : value;
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
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };

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
