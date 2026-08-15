/**
 * The route wrapper: the one place a thrown error becomes an HTTP response
 * (docs/BACKEND.md §1, §2).
 *
 * Route handlers stay thin because everything ambient — the request id, the
 * bound logger, the error mapping, the timing line — happens here. A handler
 * that throws `AppError` gets that envelope; a handler that throws anything else
 * gets a bare 500 and the detail goes to the log, not to the client.
 */
import { requestIdFrom } from "@/server/context";
import { createLogger, type Logger } from "@/server/log";
import { AppError, jsonError } from "./envelope";

export type RouteArgs<P> = {
  requestId: string;
  log: Logger;
  /** Next.js 15 hands dynamic segments as a promise; it is resolved for you. */
  params: P;
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

export function route<P = Record<string, never>>(
  handler: RouteHandler<P>,
): (request: Request, segment: RouteSegment<P>) => Promise<Response> {
  return async (request, segment) => {
    const requestId = requestIdFrom(request);
    const url = new URL(request.url);
    const log = createLogger({ requestId, method: request.method, path: url.pathname });
    const started = Date.now();

    const finish = (response: Response, error?: unknown) => {
      // A handler may return a Response built elsewhere; the id is not optional.
      if (!response.headers.get("x-request-id")) {
        response.headers.set("x-request-id", requestId);
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
      // Static routes get no params; a plain object is the honest stand-in.
      const params = ((await segment?.params) ?? {}) as P;
      return finish(await handler(request, { requestId, log, params }));
    } catch (error) {
      return finish(jsonError(error, requestId), error);
    }
  };
}
