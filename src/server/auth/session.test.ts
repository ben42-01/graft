/**
 * Where a token becomes an identity. The GRAFT-02 stub that read `x-graft-*`
 * headers is gone; these tests exist partly to keep it gone.
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppError } from "@/server/http/envelope";
import { mintAccessToken, type TokenDeps } from "@/server/services/tokens";
import { buildKeyring } from "./keys";
import { ACCESS_COOKIE } from "./cookies";
import { authenticate, contextFromRequest } from "./session";

const TENANT = "000000000000000000000001";
const USER = "00000000000000000000000b";

const pem = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const ring = buildKeyring({ privateKey: pem.privateKey, publicKey: pem.publicKey });

const denied = new Set<string>();
const tokens: Partial<TokenDeps> = {
  keyring: ring,
  denyList: {
    async deny(jti) {
      denied.add(jti);
    },
    async isDenied(jti) {
      return denied.has(jti);
    },
  },
};

const mint = (tenantId = TENANT) =>
  mintAccessToken({ tenantId, userId: USER, roles: ["owner"], tier: "premium" }, tokens);

const request = (headers: Record<string, string>) =>
  new Request("http://localhost/api/v1/things", { headers });

const expectUnauthorized = async (run: Promise<unknown>) => {
  await expect(run).rejects.toBeInstanceOf(AppError);
  await expect(run).rejects.toMatchObject({ code: "UNAUTHORIZED" });
};

describe("contextFromRequest", () => {
  it("builds a ctx from a Bearer token", async () => {
    const { token, claims } = mint();
    const ctx = await contextFromRequest(request({ authorization: `Bearer ${token}` }), {
      requestId: "trace-abc-123",
      tokens,
    });
    expect(ctx).toEqual({
      requestId: "trace-abc-123",
      tenantId: TENANT,
      userId: USER,
      roles: ["owner"],
      tier: "premium",
    });
    expect(claims.tid).toBe(ctx.tenantId);
  });

  it("builds a ctx from the httpOnly cookie", async () => {
    const { token } = mint();
    const ctx = await contextFromRequest(request({ cookie: `${ACCESS_COOKIE}=${token}` }), {
      requestId: "trace-abc-123",
      tokens,
    });
    expect(ctx.tenantId).toBe(TENANT);
  });

  /** GRAFT-02.1 AC2 — route() owns the request id; nothing here mints a second. */
  it("uses the requestId it is given", async () => {
    const { token } = mint();
    const ctx = await contextFromRequest(
      request({ authorization: `Bearer ${token}`, "x-request-id": "edge-01HZY7" }),
      { requestId: "trace-abc-123", tokens },
    );
    expect(ctx.requestId).toBe("trace-abc-123");
  });

  /**
   * The GRAFT-02.1 fail-closed guard, now unconditional. The stub authenticated
   * from headers in dev and qa and refused everywhere else; there is no
   * environment in which these headers mean anything any more.
   */
  it("no longer trusts the x-graft-* headers, in any environment", async () => {
    await expectUnauthorized(
      contextFromRequest(
        request({
          "x-graft-tenant-id": TENANT,
          "x-graft-user-id": USER,
          "x-graft-roles": "owner",
          "x-graft-tier": "enterprise",
        }),
        { tokens },
      ),
    );
  });

  it("refuses a request with no token at all", async () => {
    await expectUnauthorized(contextFromRequest(request({}), { tokens }));
  });

  it("refuses a token whose jti is on the deny-list (AC6)", async () => {
    const { token, claims } = mint();
    expect(
      (await contextFromRequest(request({ authorization: `Bearer ${token}` }), { tokens }))
        .userId,
    ).toBe(USER);

    denied.add(claims.jti);
    // Still perfectly signed, still inside its 15 minutes, and still refused.
    await expectUnauthorized(
      authenticate(request({ authorization: `Bearer ${token}` }), { tokens }),
    );
  });

  it("carries the token's tenant and no other (AC5)", async () => {
    const other = "000000000000000000000002";
    const ctx = await contextFromRequest(
      request({ authorization: `Bearer ${mint(other).token}` }),
      { tokens },
    );
    expect(ctx.tenantId).toBe(other);
    expect(Object.keys(ctx)).toEqual(["requestId", "tenantId", "userId", "roles", "tier"]);
  });
});
