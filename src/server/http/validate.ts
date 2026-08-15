/**
 * Zod at the boundary (docs/BACKEND.md §1.3).
 *
 * Route handlers never read `request.json()` or a search param directly: they
 * come through here, so a malformed request is always a 400 naming the offending
 * fields (AC4) rather than a 500 from somewhere deeper.
 */
import type { z } from "zod";
import { AppError } from "./envelope";

export type ValidationSource = "body" | "query" | "params";

/** `{ "profile.handle": "Required" }` — the shape AC4 calls "names the fields". */
export type FieldErrors = Record<string, string>;

export function fieldErrors(error: z.ZodError): FieldErrors {
  const fields: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.join(".") : "(root)";
    // First issue per field wins — the list is for a human fixing their request.
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

function validationFailed(error: z.ZodError, source: ValidationSource): AppError {
  return new AppError("VALIDATION_FAILED", `Invalid request ${source}`, {
    source,
    fields: fieldErrors(error),
  });
}

export function parse<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  source: ValidationSource,
): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw validationFailed(result.error, source);
  return result.data;
}

export async function parseBody<S extends z.ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<z.infer<S>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // Unparseable JSON is the caller's mistake, not ours — 400, not 500.
    throw new AppError("VALIDATION_FAILED", "Invalid request body", {
      source: "body",
      fields: { "(body)": "Expected a JSON document" },
    });
  }
  return parse(schema, body, "body");
}

export function parseQuery<S extends z.ZodTypeAny>(
  request: Request | URL,
  schema: S,
): z.infer<S> {
  const url = request instanceof URL ? request : new URL(request.url);
  // Repeated keys collapse to the last value; a constrained query grammar for
  // list filtering arrives with records (docs/BACKEND.md §2).
  return parse(schema, Object.fromEntries(url.searchParams.entries()), "query");
}

export function parseParams<S extends z.ZodTypeAny>(params: unknown, schema: S): z.infer<S> {
  return parse(schema, params, "params");
}
