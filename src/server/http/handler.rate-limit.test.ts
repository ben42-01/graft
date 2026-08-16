import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryBackend } from "@/server/rate-limit/backend";
import { MAX_BODY_BYTES } from "@/server/rate-limit/enforce";
import { AppError, jsonOk } from "./envelope";
import { route } from "./handler";

/**
 * GRAFT-04 wiring: the same limiter decisions, seen from outside `route()`.
 * enforce.test.ts proves the arithmetic; this file proves a route actually
 * refuses, with the envelope and headers a client is promised (AC1, AC6).
 *
 * The backend is injected, so no Redis is involved — the real one is exercised
 * by limiter.integration.test.ts and by bruno/security/rate-limit-429.bru.
 */

vi.mock("@/server/auth/session", () => ({
  contextFromRequest: async (_request: Request, options: { requestId?: string } = {}) => ({
    requestId: options.requestId ?? "unset",
    tenantId: "000000000000000000000001",
    userId: "00000000000000000000000b",
    roles: ["owner"],
    tier: "free",
  }),
}));

const silence = () => vi.spyOn(console, "log").mockImplementation(() => undefined);

afterEach(() => vi.restoreAllMocks());

const NO_PARAMS = { params: Promise.resolve({}) };

const get = (path = "/api/v1/things") =>
  new Request(`http://localhost${path}`, { headers: { "x-forwarded-for": "203.0.113.7" } });

describe("route() rate limiting", () => {
  // AC1 — the refusal is the standard envelope plus the four headers.
  it("answers 429 RATE_LIMITED with Retry-After and the X-RateLimit trio", async () => {
    silence();
    const limiter = { backend: memoryBackend() };
    const handler = route<{ slug: string }>(
      (_request, { requestId }) => jsonOk({ ok: true }, requestId),
      { rateLimit: { scopes: ["public-form"] }, limiter },
    );
    const segment = { params: Promise.resolve({ slug: "contact" }) };
    const call = () => handler(get("/api/v1/public/forms/contact/submissions"), segment);

    for (let i = 0; i < 10; i += 1) expect((await call()).status).toBe(200);

    const response = await call();
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.requestId).toBe(response.headers.get("x-request-id"));
    expect(body.data).toBeUndefined();
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(response.headers.get("x-ratelimit-limit")).toBe("10");
    expect(response.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(Number(response.headers.get("x-ratelimit-reset"))).toBeGreaterThan(
      Math.floor(Date.now() / 1000),
    );
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("tells a client where it stands on a request it allowed", async () => {
    silence();
    const handler = route((_request, { requestId }) => jsonOk({ ok: true }, requestId), {
      rateLimit: { scopes: ["global-ip"] },
      limiter: { backend: memoryBackend() },
    });
    const response = await handler(get(), NO_PARAMS);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratelimit-limit")).toBe("300");
    expect(response.headers.get("x-ratelimit-remaining")).toBe("299");
  });

  // AC2 — the tenant's budget is spent when the handler builds its context.
  it("charges the tenant scope at its tier limit once a context is built", async () => {
    silence();
    const handler = route(
      async (_request, { requestId, context }) => {
        await context();
        return jsonOk({ ok: true }, requestId);
      },
      { rateLimit: { scopes: ["api"] }, limiter: { backend: memoryBackend() } },
    );
    const response = await handler(get(), NO_PARAMS);
    expect(response.headers.get("x-ratelimit-limit")).toBe("60");
    expect(response.headers.get("x-ratelimit-remaining")).toBe("59");
  });

  it("refuses an authenticated request once the tenant's budget is gone", async () => {
    silence();
    const limiter = { backend: memoryBackend() };
    const handler = route(
      async (_request, { requestId, context }) => {
        await context();
        return jsonOk({ ok: true }, requestId);
      },
      { rateLimit: { scopes: ["api"] }, limiter },
    );
    for (let i = 0; i < 60; i += 1) expect((await handler(get(), NO_PARAMS)).status).toBe(200);
    const response = await handler(get(), NO_PARAMS);
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("RATE_LIMITED");
    expect(response.headers.get("retry-after")).toBeTruthy();
  });

  // AC3 — the failure budget is charged on the way out, not on the way in.
  it("locks credential guessing after five failures but never charges a success", async () => {
    silence();
    const limiter = { backend: memoryBackend() };
    const failing = route(
      () => {
        throw new AppError("UNAUTHORIZED", "Invalid email or password");
      },
      { rateLimit: { scopes: ["auth"] }, limiter },
    );
    const succeeding = route((_request, { requestId }) => jsonOk({ ok: true }, requestId), {
      rateLimit: { scopes: ["auth"] },
      limiter,
    });
    const login = (handler: typeof failing) =>
      handler(
        new Request("http://localhost/api/v1/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
          body: JSON.stringify({ email: "victim@qa.test", password: "wrong" }),
        }),
        NO_PARAMS,
      );

    for (let i = 0; i < 10; i += 1) expect((await login(succeeding)).status).toBe(200);
    for (let i = 0; i < 5; i += 1) expect((await login(failing)).status).toBe(401);

    const locked = await login(failing);
    expect(locked.status).toBe(429);
    expect((await locked.json()).error.code).toBe("RATE_LIMITED");
  });

  // AC6 — the body limit is applied before the handler is entered at all.
  it("rejects an oversized body with 413 without running the handler", async () => {
    silence();
    const seen: string[] = [];
    const handler = route(
      (_request, { requestId }) => {
        seen.push(requestId);
        return jsonOk({ ok: true }, requestId);
      },
      { rateLimit: { scopes: [] }, limiter: { backend: memoryBackend() } },
    );
    const response = await handler(
      new Request("http://localhost/api/v1/things", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(MAX_BODY_BYTES + 1),
        },
        body: JSON.stringify({ padding: "x" }),
      }),
      NO_PARAMS,
    );
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(seen).toEqual([]);
  });

  it("leaves the health probes unlimited", async () => {
    silence();
    const limiter = { backend: memoryBackend() };
    const handler = route((_request, { requestId }) => jsonOk({ ok: true }, requestId), {
      limiter,
    });
    const response = await handler(
      new Request("http://localhost/api/health", {
        headers: { "x-forwarded-for": "203.0.113.7" },
      }),
      NO_PARAMS,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratelimit-limit")).toBeNull();
  });
});
