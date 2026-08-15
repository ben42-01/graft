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

describe("contextFromRequest (stub until GRAFT-03)", () => {
  const headers = {
    "x-graft-tenant-id": "000000000000000000000001",
    "x-graft-user-id": "00000000000000000000000b",
    "x-graft-roles": "owner,admin",
    "x-graft-tier": "premium",
  };

  it("builds a ctx from the dev/qa stub headers", () => {
    const ctx = contextFromRequest(stubbed(headers), "qa");
    expect(ctx).toMatchObject({
      tenantId: "000000000000000000000001",
      userId: "00000000000000000000000b",
      roles: ["owner", "admin"],
      tier: "premium",
    });
    expect(ctx.requestId).toEqual(expect.any(String));
  });

  it("is UNAUTHORIZED when the stub headers are absent", () => {
    expect(() => contextFromRequest(stubbed({}), "dev")).toThrow(AppError);
    try {
      contextFromRequest(stubbed({}), "dev");
    } catch (error) {
      expect((error as AppError).code).toBe("UNAUTHORIZED");
    }
  });

  it("rejects an unknown tier or role rather than trusting the header", () => {
    expect(() =>
      contextFromRequest(stubbed({ ...headers, "x-graft-tier": "platinum" }), "qa"),
    ).toThrow(AppError);
    expect(() =>
      contextFromRequest(stubbed({ ...headers, "x-graft-roles": "superuser" }), "qa"),
    ).toThrow(AppError);
  });

  // The stub is a development affordance; in production it must never authenticate anyone.
  it("refuses to authenticate anyone in production", () => {
    try {
      contextFromRequest(stubbed(headers), "production");
      expect.unreachable("the stub must not work in production");
    } catch (error) {
      expect((error as AppError).code).toBe("UNAUTHORIZED");
    }
  });
});
