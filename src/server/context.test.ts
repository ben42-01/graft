import { describe, expect, it } from "vitest";
import { AppError } from "@/server/http/envelope";
import { contextFromRequest, createContext, requestIdFrom } from "./context";

const stubbed = (headers: Record<string, string>) =>
  new Request("http://localhost/api/v1/things", { headers });

describe("requestIdFrom", () => {
  it("generates one when the caller sends nothing", () => {
    const id = requestIdFrom(new Request("http://localhost/"));
    expect(id).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
  });

  it("accepts a well-formed inbound trace id", () => {
    expect(requestIdFrom(stubbed({ "x-request-id": "edge-01HZY7" }))).toBe("edge-01HZY7");
  });

  it("discards anything that could forge a log line", () => {
    const id = requestIdFrom(stubbed({ "x-request-id": '"} {"level":"error","msg":"forged' }));
    expect(id).not.toContain("forged");
  });
});

describe("createContext", () => {
  it("carries the tier so entitlements need no signature change later", () => {
    const ctx = createContext({
      requestId: "r-1",
      tenantId: "000000000000000000000001",
      userId: "00000000000000000000000b",
      roles: ["owner"],
      tier: "premium",
    });
    expect(ctx.tier).toBe("premium");
    expect(ctx.roles).toEqual(["owner"]);
  });
});

/**
 * GRAFT-03.1 note: nothing wires this stub up any more. `route()` builds its
 * context through src/server/auth/session.ts, which verifies an RS256 signature
 * and checks the jti deny-list (see session.test.ts). The stub and these tests
 * survive only because src/server/context.ts is a protected path that this
 * issue's Constraints did not list — removing it needs its own approval, which
 * is asked for in a comment on the issue.
 */
describe("contextFromRequest (dead stub — nothing calls it since GRAFT-03.1)", () => {
  const headers = {
    "x-graft-tenant-id": "000000000000000000000001",
    "x-graft-user-id": "00000000000000000000000b",
    "x-graft-roles": "owner,admin",
    "x-graft-tier": "premium",
  };

  it("builds a ctx from the dev/qa stub headers", () => {
    const ctx = contextFromRequest(stubbed(headers), { appEnv: "qa" });
    expect(ctx).toMatchObject({
      tenantId: "000000000000000000000001",
      userId: "00000000000000000000000b",
      roles: ["owner", "admin"],
      tier: "premium",
    });
    expect(ctx.requestId).toEqual(expect.any(String));
  });

  it("is UNAUTHORIZED when the stub headers are absent", () => {
    expect(() => contextFromRequest(stubbed({}), { appEnv: "dev" })).toThrow(AppError);
    try {
      contextFromRequest(stubbed({}), { appEnv: "dev" });
    } catch (error) {
      expect((error as AppError).code).toBe("UNAUTHORIZED");
    }
  });

  it("rejects an unknown tier or role rather than trusting the header", () => {
    expect(() =>
      contextFromRequest(stubbed({ ...headers, "x-graft-tier": "platinum" }), { appEnv: "qa" }),
    ).toThrow(AppError);
    expect(() =>
      contextFromRequest(stubbed({ ...headers, "x-graft-roles": "superuser" }), {
        appEnv: "qa",
      }),
    ).toThrow(AppError);
  });

  // The stub is a development affordance; in production it must never authenticate anyone.
  it("refuses to authenticate anyone in production", () => {
    try {
      contextFromRequest(stubbed(headers), { appEnv: "production" });
      expect.unreachable("the stub must not work in production");
    } catch (error) {
      expect((error as AppError).code).toBe("UNAUTHORIZED");
    }
  });

  /**
   * GRAFT-02.1 AC1 (F3) — the guard used to refuse only when APP_ENV was the
   * literal "production", while env.ts defaulted APP_ENV to "dev". A deploy that
   * forgot the variable therefore trusted `x-graft-tenant-id` outright and handed
   * any caller any tenant. The guard now allows, rather than denies, by name.
   */
  describe("fails closed (AC1)", () => {
    const refuses = (options: Parameters<typeof contextFromRequest>[1], why: string) => {
      try {
        contextFromRequest(stubbed(headers), options);
        expect.unreachable(why);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("UNAUTHORIZED");
      }
    };

    // An APP_ENV that is genuinely unset is rejected a layer earlier, by the env
    // schema — see env.test.ts. Here: everything that reaches the guard.
    it("refuses when APP_ENV is empty or unrecognised", () => {
      refuses({ appEnv: "" }, "an empty APP_ENV must not authenticate anyone");
      refuses({ appEnv: "staging" }, "an unknown APP_ENV must not authenticate anyone");
      refuses({ appEnv: "DEV" }, "APP_ENV is matched exactly, not case-insensitively");
    });

    it("refuses when NODE_ENV is production even if APP_ENV says dev", () => {
      refuses(
        { appEnv: "dev", nodeEnv: "production" },
        "a production NODE_ENV must not authenticate anyone",
      );
    });

    it("still serves the two environments the stub exists for", () => {
      for (const appEnv of ["dev", "qa"]) {
        expect(contextFromRequest(stubbed(headers), { appEnv }).tenantId).toBe(
          "000000000000000000000001",
        );
      }
    });
  });

  /**
   * GRAFT-02.1 AC2 (F1) — route() owns the request id. When the caller injects
   * one, the context must carry that exact value rather than minting a second.
   */
  it("uses the requestId it is given rather than minting another (AC2)", () => {
    const ctx = contextFromRequest(stubbed(headers), {
      appEnv: "qa",
      requestId: "trace-abc-123",
    });
    expect(ctx.requestId).toBe("trace-abc-123");
  });

  it("falls back to the inbound header when no requestId is injected", () => {
    const ctx = contextFromRequest(
      new Request("http://localhost/api/v1/things", {
        headers: { ...headers, "x-request-id": "edge-01HZY7" },
      }),
      { appEnv: "qa" },
    );
    expect(ctx.requestId).toBe("edge-01HZY7");
  });
});

describe("createContext validation", () => {
  const valid = {
    requestId: "r-1",
    tenantId: "000000000000000000000001",
    userId: "00000000000000000000000b",
    roles: ["owner"] as const,
    tier: "free" as const,
  };

  it("is UNAUTHORIZED, never a partial ctx, when a field is unusable", () => {
    for (const bad of [
      { ...valid, tenantId: "" },
      { ...valid, tenantId: "000000000000000000000001x" },
      { ...valid, userId: "not-an-object-id" },
      { ...valid, roles: [] as unknown as typeof valid.roles },
      { ...valid, roles: ["superuser"] as unknown as typeof valid.roles },
      { ...valid, tier: "platinum" as unknown as typeof valid.tier },
    ]) {
      try {
        createContext(bad);
        expect.unreachable("an invalid ctx must not be constructible");
      } catch (error) {
        expect((error as AppError).code).toBe("UNAUTHORIZED");
      }
    }
  });

  it("freezes the ctx, so nothing downstream can retenant itself", () => {
    const ctx = createContext(valid);
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(() => {
      (ctx as { tenantId: string }).tenantId = "000000000000000000000002";
    }).toThrow();
  });
});
