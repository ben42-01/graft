/**
 * Turning an error envelope into something a person can act on.
 *
 * `parseBody` (`src/server/http/validate.ts`) throws one generic
 * `VALIDATION_FAILED` / "Invalid request body" for *every* schema failure and
 * puts the useful part — the per-field reasons — in
 * `details.fields`. A form that renders only `error.message` therefore tells
 * the user nothing: a 5-character password and a malformed email produce the
 * same unhelpful sentence. This reads the field map back out.
 *
 * Deliberately narrow: it formats the messages the server already returns and
 * invents no validation of its own. Checking input before submit is a separate
 * concern (GRAFT-22), and the server stays the only enforcement point either
 * way — see docs/BACKEND.md.
 */

/** The error half of the envelope in `src/server/http/envelope.ts`. */
export type ApiErrorEnvelope = {
  error: { code: string; message: string; details?: unknown; requestId: string };
};

export function isApiError(body: unknown): body is ApiErrorEnvelope {
  return typeof body === "object" && body !== null && "error" in body;
}

/** `{ source: "body", fields: { password: "Use at least 12 characters" } }` */
function fieldsOf(details: unknown): Record<string, string> | null {
  if (typeof details !== "object" || details === null || !("fields" in details)) return null;
  const fields = (details as { fields: unknown }).fields;
  if (typeof fields !== "object" || fields === null) return null;
  const entries = Object.entries(fields).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/**
 * The message to show the user. Falls back to the envelope's own message when
 * there are no field details — which is the right text for the errors that
 * carry none (`CONFLICT` "an account with this email already exists",
 * `INVALID_CREDENTIALS`, and so on).
 */
export function errorMessage(
  body: unknown,
  /** Field name → the label the form shows, so the message names what the
   * user actually sees rather than the wire key (`businessName`). */
  labels: Record<string, string> = {},
): string {
  if (!isApiError(body)) return "Something went wrong.";

  const fields = fieldsOf(body.error.details);
  if (!fields) return body.error.message;

  return Object.entries(fields)
    .map(([field, message]) => `${labels[field] ?? field}: ${message}`)
    .join(" ");
}
