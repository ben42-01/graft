/**
 * The API envelope and the error-code union (docs/BACKEND.md §2).
 *
 * Every response the API produces goes through here, so the shape a client sees
 * is decided in one place: `{ data, meta }` on success, `{ error }` on failure,
 * with a `requestId` on both so a user's screenshot maps to a log line.
 *
 * Deliberately framework-free — plain `Response`, no next/server import — so it
 * is unit-testable and usable from route handlers, middleware and scripts alike.
 */

/** The stable, machine-readable codes. Clients switch on these, not on prose. */
export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  // Authentication succeeded and the account is simply not usable yet. Separate
  // from FORBIDDEN because the client's response is specific — offer to resend
  // the verification email — and branching on prose is not a contract
  // (GRAFT-03.2 AC3).
  "EMAIL_NOT_VERIFIED",
  "NOT_FOUND",
  "QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "CONFLICT",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Codes are the contract; statuses are the coarse HTTP approximation of them.
 * QUOTA_EXCEEDED is a 403: the request is well-formed and authenticated, the
 * tenant's plan simply does not allow it (docs/TIERS.md §2.2 hard stop).
 */
export const STATUS_FOR_CODE: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  EMAIL_NOT_VERIFIED: 403,
  NOT_FOUND: 404,
  QUOTA_EXCEEDED: 403,
  RATE_LIMITED: 429,
  CONFLICT: 409,
  INTERNAL: 500,
};

/** What the client is told when we will not say more (AC5). */
const INTERNAL_MESSAGE = "Something went wrong. Quote the requestId when reporting this.";

export type Meta = { requestId: string } & Record<string, unknown>;
export type SuccessEnvelope<T> = { data: T; meta: Meta };
export type ErrorEnvelope = {
  error: { code: ErrorCode; message: string; details?: unknown; requestId: string };
};

/**
 * An error we chose to raise, and are therefore willing to describe to the
 * client. Anything else that reaches the route handler is a bug and becomes a
 * bare INTERNAL.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_FOR_CODE[code];
    this.details = details;
  }
}

export function successEnvelope<T>(
  data: T,
  requestId: string,
  meta?: Record<string, unknown>,
): SuccessEnvelope<T> {
  // requestId last: caller meta can add to the envelope, never rewrite its identity.
  return { data, meta: { ...meta, requestId } };
}

export function errorEnvelope(error: unknown, requestId: string): ErrorEnvelope {
  if (error instanceof AppError && error.code !== "INTERNAL") {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
        requestId,
      },
    };
  }
  // AC5 — no message, no details, no stack, no path. The log line has all of it:
  // `route()` writes the error through redact(), which keeps the class, the
  // redacted message, the stack and the cause chain (GRAFT-02.1 AC5). The client
  // gets the requestId and nothing else; the operator gets the rest.
  return { error: { code: "INTERNAL", message: INTERNAL_MESSAGE, requestId } };
}

/**
 * Headers are composed through `new Headers`, not an object spread: `set-cookie`
 * is the one header that legitimately appears twice (rotating the refresh cookie
 * while replacing the access cookie), and spreading collapses it to one.
 */
const jsonResponse = (
  body: unknown,
  status: number,
  requestId: string,
  headers?: HeadersInit,
) => {
  const composed = new Headers(headers);
  composed.set("content-type", "application/json; charset=utf-8");
  composed.set("x-request-id", requestId);
  return new Response(JSON.stringify(body), { status, headers: composed });
};

export function jsonOk<T>(
  data: T,
  requestId: string,
  meta?: Record<string, unknown>,
  init?: { status?: number; headers?: HeadersInit },
): Response {
  return jsonResponse(
    successEnvelope(data, requestId, meta),
    init?.status ?? 200,
    requestId,
    init?.headers,
  );
}

export function jsonError(error: unknown, requestId: string, headers?: HeadersInit): Response {
  const status = error instanceof AppError ? error.status : STATUS_FOR_CODE.INTERNAL;
  return jsonResponse(errorEnvelope(error, requestId), status, requestId, headers);
}
