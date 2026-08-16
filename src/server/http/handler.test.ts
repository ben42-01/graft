import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AppError, jsonOk } from "./envelope";
import { route } from "./handler";
import { encodeCursor } from "./pagination";
import { parseBody } from "./validate";

/**
 * These tests are about route() plumbing — the request id, the envelope, the log
 * line — not about authentication, which since GRAFT-03.1 means an RS256
 * verification and a Redis round trip. Authentication proper is tested where it
 * lives, in src/server/auth/session.test.ts; here it is a stand-in whose only
 * interesting property is the requestId it was handed.
 */
/**
 * Likewise the limiter (GRAFT-04): route() now meters every request, and a unit
 * test of the plumbing should not need a Redis. What route() does with a
 * limiter decision is tested in handler.rate-limit.test.ts against an in-memory
 * backend, and the decisions themselves in src/server/rate-limit/.
 */
vi.mock("@/server/rate-limit/enforce", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/rate-limit/enforce")>()),
  enforceRateLimit: async () => ({ headers: {} }),
}));

vi.mock("@/server/auth/session", () => ({
  contextFromRequest: async (_request: Request, options: { requestId?: string } = {}) => ({
    requestId: options.requestId ?? "unset",
    tenantId: "000000000000000000000001",
    userId: "00000000000000000000000b",
    roles: ["owner"],
    tier: "free",
  }),
}));

function captureLogs() {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    lines.push(line);
  });
  return lines;
}

afterEach(() => vi.restoreAllMocks());

/** Next.js always supplies this; a static route simply has no params in it. */
const NO_PARAMS = { params: Promise.resolve({}) };

const post = (body: unknown) =>
  new Request("http://localhost/api/v1/things", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("route", () => {
  it("passes a requestId through to the handler and the response", async () => {
    captureLogs();
    const handler = route((_request, { requestId }) => jsonOk({ seen: requestId }, requestId));
    const response = await handler(new Request("http://localhost/api/v1/things"), NO_PARAMS);
    const body = await response.json();
    expect(body.meta.requestId).toBe(body.data.seen);
    expect(response.headers.get("x-request-id")).toBe(body.meta.requestId);
  });

  // AC6 — the same id on the response and in the log line for that request.
  it("logs the completed request under the same requestId", async () => {
    const lines = captureLogs();
    const handler = route((_request, { requestId }) => jsonOk({ ok: true }, requestId));
    const response = await handler(new Request("http://localhost/api/v1/things"), NO_PARAMS);
    const requestId = (await response.json()).meta.requestId;
    const entries = lines.map((line) => JSON.parse(line));
    expect(entries.some((e) => e.requestId === requestId && e.status === 200)).toBe(true);
  });

  /**
   * GRAFT-02.1 AC2 (F1) — handler.ts and context.ts each called requestIdFrom
   * independently, so with no inbound header one request minted two different
   * uuids: the response carried one, the log line the other. route() mints
   * exactly once, and every log line for the request shares that id.
   */
  it("mints exactly one requestId per request with no inbound header (AC2)", async () => {
    const lines = captureLogs();
    const handler = route((_request, { requestId, log }) => {
      log.info("handler.reached");
      return jsonOk({ seen: requestId }, requestId);
    });
    const response = await handler(new Request("http://localhost/api/v1/things"), NO_PARAMS);
    const body = await response.json();

    const logged = new Set(lines.map((line) => JSON.parse(line).requestId));
    expect(logged.size).toBe(1);
    expect([...logged][0]).toBe(body.meta.requestId);
    expect(response.headers.get("x-request-id")).toBe(body.meta.requestId);
    expect(body.data.seen).toBe(body.meta.requestId);
  });

  /**
   * The defect proper: before GRAFT-02.1 a handler that built a context got a
   * *second* uuid, so the response said one id and the ctx carried into every
   * service and log line said another.
   */
  it("gives the handler a context on the same requestId as the response (AC2)", async () => {
    const lines = captureLogs();
    const handler = route(async (_request, { requestId, context, log }) => {
      const ctx = await context();
      log.info("ctx.built", { ctxRequestId: ctx.requestId });
      return jsonOk({ ctxRequestId: ctx.requestId }, requestId);
    });
    const response = await handler(new Request("http://localhost/api/v1/things"), NO_PARAMS);
    const body = await response.json();
    expect(body.data.ctxRequestId).toBe(body.meta.requestId);
    expect(response.headers.get("x-request-id")).toBe(body.data.ctxRequestId);
    const logged = new Set(lines.map((line) => JSON.parse(line).requestId));
    expect(logged).toEqual(new Set([body.meta.requestId]));
  });

  it("honours a caller-supplied x-request-id when it is a sane token", async () => {
    captureLogs();
    const handler = route((_request, { requestId }) => jsonOk({ ok: true }, requestId));
    const response = await handler(
      new Request("http://localhost/api/v1/things", {
        headers: { "x-request-id": "trace-abc-123" },
      }),
      NO_PARAMS,
    );
    expect(response.headers.get("x-request-id")).toBe("trace-abc-123");
  });

  it("ignores a hostile x-request-id", async () => {
    captureLogs();
    const handler = route((_request, { requestId }) => jsonOk({ ok: true }, requestId));
    const response = await handler(
      new Request("http://localhost/api/v1/things", {
        headers: { "x-request-id": 'x" injected {"level":"error"' },
      }),
      NO_PARAMS,
    );
    expect(response.headers.get("x-request-id")).not.toContain("injected");
  });

  // AC4 — a Zod failure becomes a 400 with the offending fields named.
  it("turns a validation failure into a 400 VALIDATION_FAILED envelope", async () => {
    captureLogs();
    const schema = z.object({ email: z.string().email() });
    const handler = route(async (request, { requestId }) => {
      const body = await parseBody(request, schema);
      return jsonOk(body, requestId);
    });
    const response = await handler(post({ email: "nope" }), NO_PARAMS);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.details.fields.email).toEqual(expect.any(String));
    expect(body.error.requestId).toBe(response.headers.get("x-request-id"));
  });

  // AC5 — an unhandled error leaks nothing.
  it("turns an unhandled error into a bare 500 INTERNAL", async () => {
    captureLogs();
    const handler = route(() => {
      throw new Error("mongo timeout at /srv/graft/src/server/db/mongo.ts:31");
    });
    const response = await handler(new Request("http://localhost/api/v1/things"), NO_PARAMS);
    expect(response.status).toBe(500);
    const raw = await response.text();
    expect(JSON.parse(raw).error.code).toBe("INTERNAL");
    expect(raw).not.toContain("mongo timeout");
    expect(raw).not.toContain("/srv/graft");
    expect(raw).not.toContain("stack");
  });

  it("logs the failure server-side even though the client is told nothing", async () => {
    const lines = captureLogs();
    const handler = route(() => {
      throw new AppError("CONFLICT", "slug already taken");
    });
    const response = await handler(new Request("http://localhost/api/v1/things"), NO_PARAMS);
    expect(response.status).toBe(409);
    expect(lines.some((line) => JSON.parse(line).status === 409)).toBe(true);
  });

  it("awaits Next.js route params before handing them over", async () => {
    captureLogs();
    const handler = route<{ slug: string }>((_request, { params, requestId }) =>
      jsonOk({ slug: params.slug }, requestId),
    );
    const response = await handler(new Request("http://localhost/api/v1/forms/qa"), {
      params: Promise.resolve({ slug: "qa" }),
    });
    expect((await response.json()).data.slug).toBe("qa");
  });

  // AC8 — a list response is { data, meta } with an opaque cursor in meta.
  it("carries list meta alongside the data", async () => {
    captureLogs();
    const handler = route((_request, { requestId }) =>
      jsonOk([{ id: "a" }], requestId, {
        limit: 1,
        hasMore: true,
        cursor: encodeCursor({ id: "6890000000000000000000ff" }),
      }),
    );
    const body = await (
      await handler(new Request("http://localhost/api/v1/things"), NO_PARAMS)
    ).json();
    expect(body.data).toEqual([{ id: "a" }]);
    expect(body.meta).toMatchObject({ limit: 1, hasMore: true });
    expect(typeof body.meta.cursor).toBe("string");
    expect(body.meta.requestId).toEqual(expect.any(String));
  });
});
