import { describe, expect, it } from "vitest";
import { AppError } from "@/server/http/envelope";
import type { Logger } from "@/server/log";
import { memoryBackend, type LimiterBackend } from "./backend";
import {
  MAX_BODY_BYTES,
  assertBodyWithinLimit,
  enforceRateLimit,
  type EnforceDeps,
} from "./enforce";

/**
 * The decision layer: given a policy, an identity and a backend, is this request
 * allowed, what headers does it carry, and what happens when Redis is gone.
 * The backend is a port, so all of it is exercised without a live Redis.
 */

const lines: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];

const testLogger = (): Logger => {
  const at = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    lines.push({ level, message, fields });
    return undefined;
  };
  const logger: Logger = {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: () => logger,
  };
  return logger;
};

const deps = (backend: LimiterBackend): Partial<EnforceDeps> => ({ backend });

/** A backend whose every call fails the way an unreachable Redis does. */
const brokenBackend = (): LimiterBackend => ({
  consume: () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:6379")),
  peek: () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:6379")),
});

const request = (init: { url?: string; headers?: Record<string, string> } = {}) =>
  new Request(init.url ?? "http://localhost/api/v1/things", {
    headers: { "x-forwarded-for": "203.0.113.7", ...init.headers },
  });

const enforce = (overrides: Parameters<typeof enforceRateLimit>[0], backend: LimiterBackend) =>
  enforceRateLimit(overrides, deps(backend));

describe("enforceRateLimit", () => {
  // AC1 — the blocked response carries the full header set.
  it("blocks once the scope's budget is spent and reports the wait", async () => {
    const backend = memoryBackend();
    const input = {
      request: request(),
      log: testLogger(),
      scopes: ["public-form"] as const,
      identity: { ip: "203.0.113.7", formId: "contact" },
    };

    for (let i = 0; i < 10; i += 1) {
      const outcome = await enforce(input, backend);
      expect(outcome.blocked).toBeUndefined();
      expect(outcome.headers["x-ratelimit-limit"]).toBe("10");
      expect(outcome.headers["x-ratelimit-remaining"]).toBe(String(9 - i));
    }

    const blocked = await enforce(input, backend);
    expect(blocked.blocked?.scope).toBe("public-form");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(blocked.headers["x-ratelimit-limit"]).toBe("10");
    expect(blocked.headers["x-ratelimit-remaining"]).toBe("0");
    expect(Number(blocked.headers["x-ratelimit-reset"])).toBeGreaterThan(0);
  });

  // AC2 — the same request from a Premium tenant survives past the Free ceiling.
  it("applies the tenant's tier limit on the API scope", async () => {
    const backend = memoryBackend();
    const free = {
      request: request(),
      log: testLogger(),
      scopes: ["api"] as const,
      identity: { tenantId: "000000000000000000000001" },
      tier: "free" as const,
    };
    const premium = {
      ...free,
      identity: { tenantId: "000000000000000000000002" },
      tier: "premium" as const,
    };

    expect((await enforce(free, backend)).headers["x-ratelimit-limit"]).toBe("60");
    expect((await enforce(premium, backend)).headers["x-ratelimit-limit"]).toBe("600");
  });

  // AC4 — budgets are per scope; spending one does not touch another.
  it("keeps the public-form budget separate from the authenticated API budget", async () => {
    const backend = memoryBackend();
    const ip = "203.0.113.7";
    const form = {
      request: request(),
      log: testLogger(),
      scopes: ["public-form"] as const,
      identity: { ip, formId: "contact" },
    };
    for (let i = 0; i < 11; i += 1) await enforce(form, backend);
    expect((await enforce(form, backend)).blocked?.scope).toBe("public-form");

    const api = {
      request: request(),
      log: testLogger(),
      scopes: ["api"] as const,
      identity: { ip, tenantId: "000000000000000000000001" },
      tier: "free" as const,
    };
    const outcome = await enforce(api, backend);
    expect(outcome.blocked).toBeUndefined();
    expect(outcome.headers["x-ratelimit-remaining"]).toBe("59");
  });

  // Cross-tenant isolation (Test Contract): A's exhaustion is A's problem.
  it("does not throttle one tenant because another exhausted its budget", async () => {
    const backend = memoryBackend();
    const forTenant = (tenantId: string) => ({
      request: request(),
      log: testLogger(),
      scopes: ["api"] as const,
      identity: { tenantId },
      tier: "free" as const,
    });
    for (let i = 0; i < 61; i += 1)
      await enforce(forTenant("000000000000000000000001"), backend);
    expect((await enforce(forTenant("000000000000000000000001"), backend)).blocked?.scope).toBe(
      "api",
    );
    expect(
      (await enforce(forTenant("000000000000000000000002"), backend)).blocked,
    ).toBeUndefined();
  });

  it("reports the most constrained scope in the headers when several apply", async () => {
    const backend = memoryBackend();
    const outcome = await enforce(
      {
        request: request(),
        log: testLogger(),
        scopes: ["global-ip", "api", "user"] as const,
        identity: {
          ip: "203.0.113.7",
          tenantId: "000000000000000000000001",
          userId: "00000000000000000000000b",
        },
        tier: "free" as const,
      },
      backend,
    );
    // Free API is 60/min — tighter than global IP (300) and per-user (120).
    expect(outcome.headers["x-ratelimit-limit"]).toBe("60");
  });

  it("skips a scope whose identity is unavailable rather than inventing a key", async () => {
    const backend = memoryBackend();
    const outcome = await enforce(
      {
        request: request(),
        log: testLogger(),
        scopes: ["api", "user"] as const,
        identity: {},
      },
      backend,
    );
    expect(outcome.blocked).toBeUndefined();
    expect(outcome.headers["x-ratelimit-limit"]).toBeUndefined();
  });

  describe("auth scope (AC3)", () => {
    const attempt = () => ({
      request: request({ url: "http://localhost/api/v1/auth/login" }),
      log: testLogger(),
      scopes: ["auth"] as const,
      identity: { ip: "203.0.113.7", email: "victim@qa.test" },
    });

    it("locks further attempts after five failures inside the window", async () => {
      const backend = memoryBackend();
      for (let i = 0; i < 5; i += 1) {
        const outcome = await enforce(attempt(), backend);
        expect(outcome.blocked).toBeUndefined();
        await outcome.recordOutcome?.(401);
      }
      const locked = await enforce(attempt(), backend);
      expect(locked.blocked?.scope).toBe("auth");
      expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    });

    it("does not consume the failure budget on a successful login", async () => {
      const backend = memoryBackend();
      for (let i = 0; i < 20; i += 1) {
        const outcome = await enforce(attempt(), backend);
        expect(outcome.blocked).toBeUndefined();
        await outcome.recordOutcome?.(200);
      }
      expect((await enforce(attempt(), backend)).blocked).toBeUndefined();
    });

    it("counts only the attempts for that ip and address", async () => {
      const backend = memoryBackend();
      for (let i = 0; i < 5; i += 1) {
        const outcome = await enforce(attempt(), backend);
        await outcome.recordOutcome?.(401);
      }
      const other = {
        ...attempt(),
        identity: { ip: "203.0.113.7", email: "bystander@qa.test" },
      };
      expect((await enforce(other, backend)).blocked).toBeUndefined();
    });
  });

  describe("Redis outage (AC7)", () => {
    it("fails closed for the public form scope, and logs the decision", async () => {
      lines.length = 0;
      const outcome = await enforce(
        {
          request: request(),
          log: testLogger(),
          scopes: ["public-form"] as const,
          identity: { ip: "203.0.113.7", formId: "contact" },
        },
        brokenBackend(),
      );
      expect(outcome.blocked?.scope).toBe("public-form");
      expect(outcome.blocked?.degraded).toBe(true);
      expect(
        lines.some(
          (line) => line.message === "ratelimit.degraded" && line.fields?.decision === "closed",
        ),
      ).toBe(true);
    });

    it("fails open for authenticated reads, and logs the decision", async () => {
      lines.length = 0;
      const outcome = await enforce(
        {
          request: request(),
          log: testLogger(),
          scopes: ["api", "user"] as const,
          identity: {
            tenantId: "000000000000000000000001",
            userId: "00000000000000000000000b",
          },
          tier: "free" as const,
        },
        brokenBackend(),
      );
      expect(outcome.blocked).toBeUndefined();
      expect(
        lines.some(
          (line) => line.message === "ratelimit.degraded" && line.fields?.decision === "open",
        ),
      ).toBe(true);
    });

    it("never writes the limiter key — and so the address or IP — to the log", async () => {
      lines.length = 0;
      await enforce(
        {
          request: request({ url: "http://localhost/api/v1/auth/login" }),
          log: testLogger(),
          scopes: ["auth"] as const,
          identity: { ip: "203.0.113.7", email: "victim@qa.test" },
        },
        brokenBackend(),
      );
      const serialised = JSON.stringify(lines);
      expect(serialised).not.toContain("victim@qa.test");
      expect(serialised).not.toContain("203.0.113.7");
    });
  });
});

describe("assertBodyWithinLimit (AC6)", () => {
  const withLength = (bytes: number) =>
    new Request("http://localhost/api/v1/things", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(bytes) },
      body: "{}",
    });

  it("accepts a body at the 1 MB limit", () => {
    expect(MAX_BODY_BYTES).toBe(1_048_576);
    expect(() => assertBodyWithinLimit(withLength(MAX_BODY_BYTES))).not.toThrow();
  });

  it("rejects a body over the limit with a 413 and a stable code", () => {
    try {
      assertBodyWithinLimit(withLength(MAX_BODY_BYTES + 1));
      expect.unreachable("expected a 413");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("PAYLOAD_TOO_LARGE");
      expect((error as AppError).status).toBe(413);
    }
  });

  it("honours a tighter per-route limit", () => {
    expect(() => assertBodyWithinLimit(withLength(2_048), 1_024)).toThrow(AppError);
  });

  it("ignores a request with no declared length", () => {
    expect(() =>
      assertBodyWithinLimit(new Request("http://localhost/api/v1/things")),
    ).not.toThrow();
  });

  it("treats a malformed content-length as no declaration rather than as zero", () => {
    const malformed = new Request("http://localhost/api/v1/things", {
      method: "POST",
      headers: { "content-length": "not-a-number" },
      body: "{}",
    });
    expect(() => assertBodyWithinLimit(malformed)).not.toThrow();
  });
});
