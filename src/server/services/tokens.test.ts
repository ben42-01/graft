/**
 * The token service, driven through in-memory stores.
 *
 * The ports exist so this file can exist: reuse detection, family revocation and
 * the deny-list are decisions, and decisions deserve tests that state the rule
 * rather than tests that arrange a database. The Mongo and Redis implementations
 * of the same ports are proven in tokens.integration.test.ts.
 */
import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { signJwt } from "@/server/auth/jwt";
import { buildKeyring, type Keyring } from "@/server/auth/keys";
import {
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_TTL_SECONDS,
} from "@/server/auth/refresh-tokens";
import type {
  DenyList,
  IdentityStore,
  NewRefreshRecord,
  RefreshStore,
} from "@/server/auth/stores";
import { AppError } from "@/server/http/envelope";
import {
  ACCESS_TTL_SECONDS,
  endSession,
  issueSession,
  isAccessTokenDenied,
  mintAccessToken,
  rotateSession,
  verifyAccessToken,
  type TokenDeps,
} from "./tokens";

const TENANT_A = "000000000000000000000001";
const TENANT_B = "000000000000000000000002";
const USER = "00000000000000000000000b";

const pem = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const ring: Keyring = buildKeyring({ privateKey: pem.privateKey, publicKey: pem.publicKey });

/** A store that behaves like the Mongo one, including the atomic claim. */
function fakeRefreshStore() {
  const rows = new Map<string, NewRefreshRecord>();
  const key = (tenantId: string, hash: string) => `${tenantId}:${hash}`;
  const store: RefreshStore & { rows: typeof rows } = {
    rows,
    async find(tenantId, tokenHash) {
      const row = rows.get(key(tenantId, tokenHash));
      // A copy, like a real driver: a caller holding a snapshot must not see a
      // concurrent write, or the TOCTOU the atomic claim exists for is hidden.
      return row ? { ...row } : null;
    },
    async claim(tenantId, tokenHash, now) {
      const row = rows.get(key(tenantId, tokenHash));
      if (!row || row.usedAt || row.revokedAt) return null;
      const before = { ...row };
      row.usedAt = now;
      return before;
    },
    async insert(record) {
      rows.set(key(record.tenantId, record.tokenHash), { ...record });
    },
    async revokeFamily(tenantId, familyId, now) {
      for (const row of rows.values()) {
        if (row.tenantId === tenantId && row.familyId === familyId && !row.revokedAt) {
          row.revokedAt = now;
        }
      }
    },
  };
  return store;
}

function fakeDenyList() {
  const denied = new Map<string, number>();
  const list: DenyList & { denied: typeof denied } = {
    denied,
    async deny(jti, ttlSeconds) {
      denied.set(jti, ttlSeconds);
    },
    async isDenied(jti) {
      return denied.has(jti);
    },
  };
  return list;
}

const identity: IdentityStore = {
  async resolve(tenantId) {
    return tenantId === TENANT_A
      ? { roles: ["owner", "admin"], tier: "premium" }
      : { roles: ["member"], tier: "free" };
  },
};

const NOW = new Date("2026-08-16T12:00:00.000Z");

let refresh: ReturnType<typeof fakeRefreshStore>;
let denyList: ReturnType<typeof fakeDenyList>;
let deps: Partial<TokenDeps>;

beforeEach(() => {
  refresh = fakeRefreshStore();
  denyList = fakeDenyList();
  deps = { keyring: ring, refresh, denyList, identity, now: () => NOW };
});

const at = (offsetSeconds: number): Partial<TokenDeps> => ({
  ...deps,
  now: () => new Date(NOW.getTime() + offsetSeconds * 1000),
});

const expectUnauthorized = async (run: Promise<unknown>) => {
  await expect(run).rejects.toBeInstanceOf(AppError);
  await expect(run).rejects.toMatchObject({ code: "UNAUTHORIZED" });
};

describe("mintAccessToken", () => {
  it("carries the claim set docs/BACKEND.md §3.1 specifies", () => {
    const { claims } = mintAccessToken(
      { tenantId: TENANT_A, userId: USER, roles: ["owner"], tier: "premium" },
      deps,
    );
    expect(Object.keys(claims).sort()).toEqual([
      "exp",
      "iat",
      "jti",
      "roles",
      "sub",
      "tid",
      "tier",
    ]);
    expect(claims).toMatchObject({ sub: USER, tid: TENANT_A, tier: "premium" });
  });

  it("expires in exactly 15 minutes", () => {
    const { claims } = mintAccessToken(
      { tenantId: TENANT_A, userId: USER, roles: ["owner"], tier: "free" },
      deps,
    );
    expect(claims.exp - claims.iat).toBe(ACCESS_TTL_SECONDS);
    expect(claims.exp - claims.iat).toBe(900);
  });

  it("gives every token a distinct jti, so revocation is per-session", () => {
    const input = {
      tenantId: TENANT_A,
      userId: USER,
      roles: ["owner"] as const,
      tier: "free" as const,
    };
    expect(mintAccessToken(input, deps).claims.jti).not.toBe(
      mintAccessToken(input, deps).claims.jti,
    );
  });

  /** AC5 — stated as a test because it is the invariant, not an implementation detail. */
  it("carries exactly one tenant, and rejects anything that is not one id", () => {
    const { claims } = mintAccessToken(
      { tenantId: TENANT_A, userId: USER, roles: ["owner"], tier: "free" },
      deps,
    );
    expect(typeof claims.tid).toBe("string");
    expect(claims.tid).toBe(TENANT_A);
    for (const notATenant of ["", `${TENANT_A},${TENANT_B}`, "*"]) {
      expect(() =>
        mintAccessToken(
          { tenantId: notATenant, userId: USER, roles: ["owner"], tier: "free" },
          deps,
        ),
      ).toThrow();
    }
  });
});

describe("verifyAccessToken", () => {
  const mint = () =>
    mintAccessToken({ tenantId: TENANT_A, userId: USER, roles: ["owner"], tier: "free" }, deps)
      .token;

  it("accepts what mintAccessToken produced", () => {
    expect(verifyAccessToken(mint(), deps).tid).toBe(TENANT_A);
  });

  it("refuses it once the 15 minutes and the skew are gone (AC4)", () => {
    const token = mint();
    expect(verifyAccessToken(token, at(ACCESS_TTL_SECONDS - 1)).sub).toBe(USER);
    expect(() => verifyAccessToken(token, at(ACCESS_TTL_SECONDS + 120))).toThrow(AppError);
  });

  it("refuses a correctly signed token whose claims are not our shape", () => {
    const other = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const otherRing = buildKeyring({
      privateKey: other.privateKey,
      publicKey: other.publicKey,
    });
    // Same private key we trust, but a claim set that fails the schema.
    const wrongShape = signJwt(
      { sub: USER, tid: TENANT_A, roles: [], tier: "free", iat: 0, exp: 2 ** 31, jti: "x" },
      ring.signing,
    );
    expect(() => verifyAccessToken(wrongShape, deps)).toThrow(AppError);
    // ...and a token from a key we do not publish is refused outright (AC4).
    const foreign = signJwt(
      {
        sub: USER,
        tid: TENANT_A,
        roles: ["owner"],
        tier: "free",
        iat: 0,
        exp: 2 ** 31,
        jti: "aaaaaaaa",
      },
      otherRing.signing,
    );
    expect(() => verifyAccessToken(foreign, deps)).toThrow(AppError);
  });
});

describe("issueSession", () => {
  it("stores only a hash of the refresh token", async () => {
    const session = await issueSession(
      { tenantId: TENANT_A, userId: USER, roles: ["owner"], tier: "premium" },
      deps,
    );
    const stored = [...refresh.rows.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0].tokenHash).toBe(hashRefreshToken(session.refreshToken));
    expect(JSON.stringify(stored[0])).not.toContain(session.refreshToken.split(".")[1]);
    expect(stored[0].expiresAt.getTime()).toBe(NOW.getTime() + REFRESH_TTL_SECONDS * 1000);
  });

  it("starts a new family when none is continued", async () => {
    const first = await issueSession(
      { tenantId: TENANT_A, userId: USER, roles: ["owner"], tier: "free" },
      deps,
    );
    const second = await issueSession(
      { tenantId: TENANT_A, userId: USER, roles: ["owner"], tier: "free" },
      deps,
    );
    const families = new Set([...refresh.rows.values()].map((r) => r.familyId));
    expect(families.size).toBe(2);
    expect(first.refreshToken).not.toBe(second.refreshToken);
  });
});

describe("rotateSession", () => {
  const start = () =>
    issueSession({ tenantId: TENANT_A, userId: USER, roles: ["owner"], tier: "premium" }, deps);

  it("returns a new access token AND a new refresh token (AC2)", async () => {
    const first = await start();
    const second = await rotateSession(first.refreshToken, deps);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(verifyAccessToken(second.accessToken, deps).tid).toBe(TENANT_A);
    // Same family — rotation continues a chain rather than starting one.
    const rows = [...refresh.rows.values()];
    expect(new Set(rows.map((r) => r.familyId)).size).toBe(1);
  });

  it("kills the presented token from that moment (AC2)", async () => {
    const first = await start();
    await rotateSession(first.refreshToken, deps);
    await expectUnauthorized(rotateSession(first.refreshToken, deps));
  });

  it("revokes the entire family on reuse, unspent siblings included (AC3)", async () => {
    const first = await start();
    const second = await rotateSession(first.refreshToken, deps);

    // The attacker replays the token the victim already spent.
    await expectUnauthorized(rotateSession(first.refreshToken, deps));

    // The victim's still-unused token — issued before the replay — is dead too.
    await expectUnauthorized(rotateSession(second.refreshToken, deps));
    expect([...refresh.rows.values()].every((row) => row.revokedAt)).toBe(true);
  });

  it("treats two simultaneous presentations as reuse (AC3)", async () => {
    const first = await start();
    const [a, b] = await Promise.allSettled([
      rotateSession(first.refreshToken, deps),
      rotateSession(first.refreshToken, deps),
    ]);
    // Exactly one wins; the loser is not merely refused, it takes the family down.
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect([...refresh.rows.values()].some((row) => row.revokedAt)).toBe(true);
  });

  it("refuses an expired token WITHOUT revoking the family", async () => {
    const first = await start();
    await expectUnauthorized(rotateSession(first.refreshToken, at(REFRESH_TTL_SECONDS + 1)));
    // An idle month is not evidence of theft.
    expect([...refresh.rows.values()].every((row) => row.revokedAt === null)).toBe(true);
  });

  it("refuses a token presented under another tenant's id (AC5)", async () => {
    const first = await start();
    const secret = first.refreshToken.split(".")[1];
    await expectUnauthorized(rotateSession(`${TENANT_B}.${secret}`, deps));
    // ...and the legitimate token is untouched by the attempt.
    expect((await rotateSession(first.refreshToken, deps)).accessToken).toBeTruthy();
  });

  it("refuses a malformed, missing or unknown token", async () => {
    for (const bad of [null, undefined, "", "garbage", generateRefreshToken(TENANT_A)]) {
      await expectUnauthorized(rotateSession(bad, deps));
    }
  });

  it("re-reads roles and tier rather than trusting the old token", async () => {
    const first = await issueSession(
      { tenantId: TENANT_A, userId: USER, roles: ["member"], tier: "free" },
      deps,
    );
    const rotated = await rotateSession(first.refreshToken, deps);
    // The identity store says owner/admin + premium; the old token said otherwise.
    expect(verifyAccessToken(rotated.accessToken, deps)).toMatchObject({
      roles: ["owner", "admin"],
      tier: "premium",
    });
  });

  it("refuses when the membership is gone", async () => {
    const first = await start();
    const gone: IdentityStore = {
      async resolve() {
        return null;
      },
    };
    await expectUnauthorized(rotateSession(first.refreshToken, { ...deps, identity: gone }));
  });
});

describe("endSession (AC6)", () => {
  it("denies the jti for the rest of the token's life", async () => {
    const session = await issueSession(
      { tenantId: TENANT_A, userId: USER, roles: ["owner"], tier: "free" },
      deps,
    );
    expect(await isAccessTokenDenied(session.claims.jti, deps)).toBe(false);

    await endSession({ claims: session.claims, presentedRefresh: session.refreshToken }, deps);

    expect(await isAccessTokenDenied(session.claims.jti, deps)).toBe(true);
    // TTL outlives the token by the skew allowance, and no longer.
    expect(denyList.denied.get(session.claims.jti)).toBe(ACCESS_TTL_SECONDS + 60);
  });

  it("revokes the refresh family too — a logout that leaves one live is theatre", async () => {
    const session = await issueSession(
      { tenantId: TENANT_A, userId: USER, roles: ["owner"], tier: "free" },
      deps,
    );
    await endSession({ claims: session.claims, presentedRefresh: session.refreshToken }, deps);
    await expectUnauthorized(rotateSession(session.refreshToken, deps));
  });

  it("will not revoke a family belonging to another tenant", async () => {
    const mine = await issueSession(
      { tenantId: TENANT_A, userId: USER, roles: ["owner"], tier: "free" },
      deps,
    );
    const theirs = await issueSession(
      { tenantId: TENANT_B, userId: USER, roles: ["member"], tier: "free" },
      deps,
    );
    await endSession({ claims: mine.claims, presentedRefresh: theirs.refreshToken }, deps);

    // Their session survives an attempt to log it out from ours.
    expect((await rotateSession(theirs.refreshToken, deps)).accessToken).toBeTruthy();
  });

  it("still denies the jti when no refresh cookie was presented", async () => {
    const session = await issueSession(
      { tenantId: TENANT_A, userId: USER, roles: ["owner"], tier: "free" },
      deps,
    );
    await endSession({ claims: session.claims, presentedRefresh: null }, deps);
    expect(await isAccessTokenDenied(session.claims.jti, deps)).toBe(true);
  });
});
