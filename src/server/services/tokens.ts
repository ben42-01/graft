/**
 * The token service — the security core (docs/BACKEND.md §3.1).
 * PROTECTED PATH (.github/agent-policy.yml).
 *
 * Everything that decides whether a caller is who they say they are lives here,
 * behind the ports in ../auth/stores.ts. Routes parse and delegate; they make no
 * decisions of their own.
 *
 * The three properties this file exists to guarantee:
 *
 *   - **One token, one tenant** (AC5). `tid` is a single string, taken from the
 *     refresh token's own record. There is no plural, no array, and no argument
 *     anywhere below that could put two tenants on one token.
 *   - **Refresh tokens are single use** (AC2). Rotation marks the presented
 *     token used in the same atomic operation that reads it.
 *   - **Reuse is treated as theft** (AC3). A second presentation cannot be
 *     distinguished from a replay, so the entire family dies — including the
 *     tokens the attacker has not spent yet.
 *
 * No function here returns, logs or embeds a token value in an error. Failures
 * are a bare UNAUTHORIZED; the detail belongs in the deny-list and the family
 * revocation, not in the response body.
 */
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { keyring, type Keyring } from "@/server/auth/keys";
import { signJwt, verifyJwt } from "@/server/auth/jwt";
import {
  REFRESH_TTL_SECONDS,
  generateRefreshToken,
  hashRefreshToken,
  parseRefreshToken,
} from "@/server/auth/refresh-tokens";
import {
  mongoIdentityStore,
  mongoRefreshStore,
  redisDenyList,
  type DenyList,
  type IdentityStore,
  type RefreshStore,
} from "@/server/auth/stores";
import { ROLES, type Role } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import { TIERS, type Tier } from "@/server/tiers";

/** docs/BACKEND.md §3.1 — "short-lived JWT (15 min)". */
export const ACCESS_TTL_SECONDS = 15 * 60;

export const accessClaimsSchema = z.object({
  sub: z.string().regex(/^[0-9a-f]{24}$/i),
  tid: z.string().regex(/^[0-9a-f]{24}$/i),
  roles: z.array(z.enum(ROLES)).min(1),
  tier: z.enum(TIERS),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string().min(8).max(64),
});

export type AccessClaims = z.infer<typeof accessClaimsSchema>;

export type Session = {
  accessToken: string;
  /** ISO-8601 UTC, per docs/BACKEND.md §2. */
  expiresAt: string;
  refreshToken: string;
  refreshMaxAge: number;
  claims: AccessClaims;
};

export type TokenDeps = {
  keyring: Keyring;
  refresh: RefreshStore;
  identity: IdentityStore;
  denyList: DenyList;
  now: () => Date;
};

/** `??` is lazy, so an injected dependency is never built and then discarded. */
function resolve(overrides: Partial<TokenDeps> = {}): TokenDeps {
  return {
    keyring: overrides.keyring ?? keyring(),
    refresh: overrides.refresh ?? mongoRefreshStore(),
    identity: overrides.identity ?? mongoIdentityStore(),
    denyList: overrides.denyList ?? redisDenyList(),
    now: overrides.now ?? (() => new Date()),
  };
}

const unauthorized = (): never => {
  throw new AppError("UNAUTHORIZED", "Invalid or expired token");
};

export type AccessTokenInput = {
  tenantId: string;
  userId: string;
  roles: readonly Role[];
  tier: Tier;
};

export function mintAccessToken(
  input: AccessTokenInput,
  overrides: Partial<TokenDeps> = {},
): { token: string; claims: AccessClaims } {
  const deps = resolve(overrides);
  const issued = Math.floor(deps.now().getTime() / 1000);
  const claims = accessClaimsSchema.parse({
    sub: input.userId,
    // Singular, and the only place a tid is ever put on a token.
    tid: input.tenantId,
    roles: input.roles,
    tier: input.tier,
    iat: issued,
    exp: issued + ACCESS_TTL_SECONDS,
    jti: randomUUID(),
  });
  return { token: signJwt(claims, deps.keyring.signing), claims };
}

/**
 * Signature, then shape. AC4: expired, wrong-key and tampered tokens all land
 * here as the same UNAUTHORIZED — `verifyJwt` refuses to say which.
 */
export function verifyAccessToken(
  token: string,
  overrides: Partial<TokenDeps> = {},
): AccessClaims {
  const deps = resolve(overrides);
  const claims = verifyJwt(token, deps.keyring.verification, deps.now().getTime());
  const parsed = accessClaimsSchema.safeParse(claims);
  // A correctly signed token with claims we do not recognise is still ours, and
  // still not usable — a shape change must fail closed, not fall through.
  return parsed.success ? parsed.data : unauthorized();
}

export async function isAccessTokenDenied(
  jti: string,
  overrides: Partial<TokenDeps> = {},
): Promise<boolean> {
  return resolve(overrides).denyList.isDenied(jti);
}

/**
 * Mints a fresh session. `familyId` continues an existing chain (rotation);
 * omitting it starts a new one, which is what login will do in GRAFT-03.2.
 */
export async function issueSession(
  input: AccessTokenInput & { familyId?: string },
  overrides: Partial<TokenDeps> = {},
): Promise<Session> {
  const deps = resolve(overrides);
  const now = deps.now();
  const { token, claims } = mintAccessToken(input, deps);

  const refreshToken = generateRefreshToken(input.tenantId);
  await deps.refresh.insert({
    tenantId: input.tenantId,
    userId: input.userId,
    // A family id is only ever compared, never dereferenced — ObjectId is used
    // for it so the stored document is uniform with every other id we keep.
    familyId: input.familyId ?? new ObjectId().toHexString(),
    tokenHash: hashRefreshToken(refreshToken),
    expiresAt: new Date(now.getTime() + REFRESH_TTL_SECONDS * 1000),
    usedAt: null,
    revokedAt: null,
  });

  return {
    accessToken: token,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    refreshToken,
    refreshMaxAge: REFRESH_TTL_SECONDS,
    claims,
  };
}

/**
 * AC2 + AC3. Ordering matters and is the whole security argument:
 *
 *   1. Look the token up scoped to the tenant it names — a stolen secret spent
 *      against another tenant simply misses (bruno/auth/refresh-cross-tenant).
 *   2. Already used or already revoked → this is reuse. Kill the family.
 *   3. Naturally expired → refuse, but do *not* kill the family: an expiry is
 *      not evidence of theft, and revoking on it would log honest users out of
 *      every device whenever one sat idle.
 *   4. Claim it atomically. Losing that race is two live presentations of one
 *      token, which is reuse by another name.
 *   5. Re-read roles and tier from the database, never from the old token.
 */
export async function rotateSession(
  presented: string | null | undefined,
  overrides: Partial<TokenDeps> = {},
): Promise<Session> {
  const deps = resolve(overrides);
  const parsed = parseRefreshToken(presented);
  if (!parsed) return unauthorized();

  const now = deps.now();
  const hash = hashRefreshToken(parsed.token);
  const record = await deps.refresh.find(parsed.tenantId, hash);
  if (!record) return unauthorized();

  if (record.usedAt || record.revokedAt) {
    await deps.refresh.revokeFamily(parsed.tenantId, record.familyId, now);
    return unauthorized();
  }
  if (record.expiresAt.getTime() <= now.getTime()) return unauthorized();

  const claimed = await deps.refresh.claim(parsed.tenantId, hash, now);
  if (!claimed) {
    await deps.refresh.revokeFamily(parsed.tenantId, record.familyId, now);
    return unauthorized();
  }

  const identity = await deps.identity.resolve(record.tenantId, record.userId);
  if (!identity) return unauthorized();

  return issueSession(
    {
      tenantId: record.tenantId,
      userId: record.userId,
      roles: identity.roles,
      tier: identity.tier,
      familyId: record.familyId,
    },
    deps,
  );
}

/**
 * AC6. The access token stays cryptographically valid for the rest of its 15
 * minutes, so revocation is a deny-list entry that outlives it by the clock skew
 * we allow. The refresh side is revoked family-wide: leaving a live refresh
 * token behind after a logout would make the logout decorative.
 */
export async function endSession(
  input: { claims: AccessClaims; presentedRefresh?: string | null },
  overrides: Partial<TokenDeps> = {},
): Promise<void> {
  const deps = resolve(overrides);
  const now = deps.now();
  const remaining = input.claims.exp - Math.floor(now.getTime() / 1000);
  await deps.denyList.deny(input.claims.jti, remaining + 60);

  const parsed = parseRefreshToken(input.presentedRefresh);
  if (!parsed) return;
  const record = await deps.refresh.find(parsed.tenantId, hashRefreshToken(parsed.token));
  // Only a token belonging to the tenant on the access token — a logout must not
  // become a way to revoke someone else's family.
  if (record && record.tenantId === input.claims.tid) {
    await deps.refresh.revokeFamily(record.tenantId, record.familyId, now);
  }
}
