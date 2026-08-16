import { describe, expect, it } from "vitest";
import { createContext, requestIdFrom } from "./context";

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
