/**
 * Where a verified token becomes a `Ctx` (docs/BACKEND.md §3.1).
 * PROTECTED PATH (.github/agent-policy.yml).
 *
 * This replaces the GRAFT-02 development stub that read `x-graft-*` headers.
 * That stub fell back to UNAUTHORIZED outside dev/qa (GRAFT-02.1 AC1); there is
 * no fallback here at all, in any environment — a caller is authenticated by an
 * RS256 signature we can verify, or not at all. The header path is gone rather
 * than narrowed, which is the strictly stronger version of the same guarantee.
 *
 * Lives beside the token service rather than in context.ts so that context.ts
 * stays a leaf: it defines what a Ctx *is*, and would otherwise have to import
 * the service that imports the stores that import it.
 */
import { readAccessToken, readCookie, REFRESH_COOKIE } from "./cookies";
import { createContext, requestIdFrom, type Ctx } from "@/server/context";
import {
  isAccessTokenDenied,
  verifyAccessToken,
  type AccessClaims,
  type TokenDeps,
} from "@/server/services/tokens";
import { AppError } from "@/server/http/envelope";

export type SessionOptions = {
  /** The id route() already minted, so one request has exactly one id. */
  requestId?: string;
  /** Test seam — the same override bag the token service takes. */
  tokens?: Partial<TokenDeps>;
};

/** The verified claims, or UNAUTHORIZED. Nothing in between. */
export async function authenticate(
  request: Request,
  options: SessionOptions = {},
): Promise<AccessClaims> {
  const token = readAccessToken(request);
  if (!token) throw new AppError("UNAUTHORIZED", "Invalid or expired token");

  const claims = verifyAccessToken(token, options.tokens);
  // AC6 — a signature that still verifies is not the same as a live session.
  if (await isAccessTokenDenied(claims.jti, options.tokens)) {
    throw new AppError("UNAUTHORIZED", "Invalid or expired token");
  }
  return claims;
}

export const ctxFromClaims = (claims: AccessClaims, requestId: string): Ctx =>
  createContext({
    requestId,
    tenantId: claims.tid,
    userId: claims.sub,
    roles: claims.roles,
    tier: claims.tier,
  });

export async function contextFromRequest(
  request: Request,
  options: SessionOptions = {},
): Promise<Ctx> {
  const claims = await authenticate(request, options);
  return ctxFromClaims(claims, options.requestId ?? requestIdFrom(request));
}

/** The refresh cookie as presented, unvalidated — the service parses it. */
export const presentedRefreshToken = (request: Request): string | null =>
  readCookie(request, REFRESH_COOKIE);
