/**
 * The route wrapper: the one place a thrown error becomes an HTTP response
 * (docs/BACKEND.md §1, §2), and since GRAFT-04 the one place a request is
 * metered (docs/BACKEND.md §4).
 *
 * Route handlers stay thin because everything ambient — the request id, the
 * bound logger, the error mapping, the timing line, the rate-limit decision —
 * happens here. A handler that throws `AppError` gets that envelope; a handler
 * that throws anything else gets a bare 500 and the detail goes to the log, not
 * to the client.
 *
 * Rate limiting is applied in two places, because the identity it needs arrives
 * at two different times:
 *
 *   - the IP-keyed scopes before the handler runs, since an address is known
 *     from the first byte;
 *   - the tenant- and user-keyed scopes when the handler builds its context,
 *     since until a token has been verified there is no tenant to charge — and
 *     charging one the caller merely *claimed* is exactly the thing the tenant
 *     isolation boundary exists to prevent.
 */
import { contextFromRequest } from "@/server/auth/session";
import { type Ctx, requestIdFrom } from "@/server/context";
import { createLogger, type Logger } from "@/server/log";
import {
  assertBodyWithinLimit,
  enforceRateLimit,
  type EnforceDeps,
} from "@/server/rate-limit/enforce";
import { policyForPath, type RoutePolicy } from "@/server/rate-limit/policy";
import { clientIp, type RateLimitScope, type ScopeIdentity } from "@/server/rate-limit/scopes";
import { AppError, jsonError } from "./envelope";

export type RouteArgs<P> = {
  requestId: string;
  log: Logger;
  /** Next.js 15 hands dynamic segments as a promise; it is resolved for you. */
  params: P;
  /**
   * The request context, built against the id `route()` already minted.
   * Handlers that need a tenant call this instead of `contextFromRequest`
   * directly, so a request can never end up with two different request ids
   * (GRAFT-02.1 AC1) — one on the response, another in the log line.
   *
   * Asynchronous since GRAFT-03.1: authenticating means verifying the RS256
   * signature *and* checking the jti deny-list in Redis, and a revocation check
   * that could be skipped by forgetting an await is not a revocation check.
   *
   * Memoised since GRAFT-04: it also spends the tenant's rate-limit budget, and
   * a handler that asked for its context twice should not be charged twice.
   */
  context: () => Promise<Ctx>;
};

export type RouteHandler<P> = (
  request: Request,
  args: RouteArgs<P>,
) => Response | Promise<Response>;

/**
 * Next.js always passes this second argument, and its generated route types
 * insist it is not optional — so it is required here and tolerated as absent at
 * runtime, which is what a direct unit-test call looks like.
 */
export type RouteSegment<P> = { params: Promise<P> };

export type RouteOptions = {
  /**
   * The route stating its own rate-limit scopes (docs/BACKEND.md §4). Omitted,
   * the path-based table in rate-limit/policy.ts decides — so an endpoint is
   * limited by default and a *loosening* is what has to be written down.
   */
  rateLimit?: RoutePolicy;
  /** Test seam: the limiter backend. Production uses Redis. */
  limiter?: Partial<EnforceDeps>;
  /**
   * Extra headers merged onto every response this route produces, success or
   * error alike (docs/BACKEND.md §4 — "public form embed endpoints get a
   * separate permissive-but-scoped [CORS] policy", distinct from the app
   * origin lock everything else gets). Opt-in per route, not a global CORS
   * layer: only a route that passes this gets anything beyond the default.
   */
  headers?: Record<string, string>;
};

/** Scopes whose key can only be known once a token has been verified. */
const AUTHENTICATED_SCOPES: ReadonlySet<RateLimitScope> = new Set<RateLimitScope>([
  "api",
  "user",
  "connector",
]);

const rateLimited = (retryAfter: number) =>
  new AppError("RATE_LIMITED", "Too many requests. Retry after the interval in Retry-After.", {
    retryAfterSeconds: retryAfter,
  });

/**
 * The dynamic segment a public form route is keyed on, when there is one.
 * GRAFT-09's submission route is `[tenantSlug]/[formSlug]/submissions` (two
 * plain segments, not a catch-all — Next.js does not allow a static segment
 * after one, and `forms.publicSlug` is always exactly two parts anyway), so
 * both are joined back into the same `tenantSlug/formSlug` identity the
 * service itself reconstructs, keeping one `public-form` rate-limit bucket
 * per form regardless of which route shape produced the params.
 */
function formIdFrom(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const bag = params as Record<string, unknown>;
  if (typeof bag.tenantSlug === "string" && typeof bag.formSlug === "string") {
    return `${bag.tenantSlug}/${bag.formSlug}`;
  }
  const candidate = bag.slug ?? bag.formId;
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * The address a login is being attempted against, read from a *copy* of the
 * request so the handler still gets an unconsumed body. Anything unreadable
 * simply yields no email, and the auth scope is skipped rather than guessed at.
 */
async function attemptedEmail(request: Request): Promise<string | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  try {
    const body: unknown = await request.clone().json();
    if (!body || typeof body !== "object") return undefined;
    const email = (body as Record<string, unknown>).email;
    return typeof email === "string" ? email : undefined;
  } catch {
    return undefined;
  }
}

export function route<P = Record<string, never>>(
  handler: RouteHandler<P>,
  options: RouteOptions = {},
): (request: Request, segment: RouteSegment<P>) => Promise<Response> {
  return async (request, segment) => {
    const requestId = requestIdFrom(request);
    const url = new URL(request.url);
    const log = createLogger({ requestId, method: request.method, path: url.pathname });
    const started = Date.now();
    const policy = options.rateLimit ?? policyForPath(url.pathname);
    const ip = clientIp(request);

    /**
     * What the client is told about its budget. Kept as the *tightest* answer
     * seen across the scopes that applied — telling a caller it has 299 requests
     * left when its tenant has 4 would be worse than saying nothing.
     */
    const limitHeaders: Record<string, string> = {};
    const noteHeaders = (next: Record<string, string>) => {
      const seen = limitHeaders["x-ratelimit-remaining"];
      const tighter =
        seen === undefined || Number(next["x-ratelimit-remaining"]) <= Number(seen);
      if (next["retry-after"] || tighter) Object.assign(limitHeaders, next);
    };

    /** Set once the up-front scopes have been resolved; see AC3. */
    let recordOutcome: ((status: number) => Promise<void>) | undefined;

    const finish = (response: Response, error?: unknown) => {
      // A handler may return a Response built elsewhere; the id is not optional.
      if (!response.headers.get("x-request-id")) {
        response.headers.set("x-request-id", requestId);
      }
      for (const [name, value] of Object.entries(limitHeaders)) {
        response.headers.set(name, value);
      }
      for (const [name, value] of Object.entries(options.headers ?? {})) {
        response.headers.set(name, value);
      }
      const fields = { status: response.status, durationMs: Date.now() - started };
      if (!error) log.info("request.completed", fields);
      else if (response.status < 500)
        log.warn("request.rejected", {
          ...fields,
          code: error instanceof AppError ? error.code : undefined,
        });
      // The only place the real cause is ever written down.
      else log.error("request.failed", { ...fields, error });
      return response;
    };

    try {
      // AC6 — before the params are awaited, let alone the handler entered.
      assertBodyWithinLimit(request, policy.bodyLimitBytes);

      // Static routes get no params; a plain object is the honest stand-in.
      const params = ((await segment?.params) ?? {}) as P;

      const anonymousScopes = policy.scopes.filter((scope) => !AUTHENTICATED_SCOPES.has(scope));
      const identity: ScopeIdentity = { ip };
      if (anonymousScopes.includes("public-form")) identity.formId = formIdFrom(params);
      if (anonymousScopes.includes("auth")) identity.email = await attemptedEmail(request);

      const upfront = anonymousScopes.length
        ? await enforceRateLimit(
            { request, log, scopes: anonymousScopes, identity },
            options.limiter,
          )
        : { headers: {} as Record<string, string> };
      noteHeaders(upfront.headers);
      recordOutcome = upfront.recordOutcome;
      if (upfront.blocked) {
        const error = rateLimited(upfront.blocked.retryAfterSeconds);
        return finish(jsonError(error, requestId), error);
      }

      const authenticatedScopes = policy.scopes.filter((scope) =>
        AUTHENTICATED_SCOPES.has(scope),
      );
      let pending: Promise<Ctx> | undefined;
      const context = () =>
        (pending ??= (async () => {
          const ctx = await contextFromRequest(request, { requestId });
          if (!authenticatedScopes.length) return ctx;
          const outcome = await enforceRateLimit(
            {
              request,
              log,
              scopes: authenticatedScopes,
              identity: { ...identity, tenantId: ctx.tenantId, userId: ctx.userId },
              tier: ctx.tier,
            },
            options.limiter,
          );
          noteHeaders(outcome.headers);
          if (outcome.blocked) throw rateLimited(outcome.blocked.retryAfterSeconds);
          return ctx;
        })());

      const response = await handler(request, { requestId, log, params, context });
      // AC3 — the failure budget is charged on the way out, so a correct
      // password costs nothing.
      await recordOutcome?.(response.status);
      return finish(response);
    } catch (error) {
      const response = jsonError(error, requestId);
      // A handler that *threw* its rejection — `throw new AppError("UNAUTHORIZED")`
      // is how the login service says "wrong password" — charges the budget
      // exactly as one that returned the same status would.
      await recordOutcome?.(response.status);
      return finish(response, error);
    }
  };
}
