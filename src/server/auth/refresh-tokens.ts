/**
 * The opaque refresh token — format, generation and hashing (AC7).
 * PROTECTED PATH (.github/agent-policy.yml).
 *
 * Pure crypto, no database, no environment: the QA seed imports it to produce
 * fixtures that hash to the same value the server will compute, and it must be
 * safe to import from a script.
 *
 * Format: `<tenantIdHex>.<secret>`
 *
 * The tenant id is a *routing* prefix, not a claim — it decides which tenant's
 * tokens we look in, and the stored document must carry the same tenant or the
 * lookup misses. Changing the prefix therefore cannot widen access; it can only
 * point the query at a tenant where the hash does not exist (see
 * bruno/auth/refresh-cross-tenant.bru). The prefix is what lets a pre-auth
 * lookup still be tenant-scoped, which is otherwise impossible: at that moment
 * there is no ctx to scope it by.
 *
 * Only the SHA-256 of the whole token is stored. A dump of `refresh_tokens`
 * yields nothing spendable, and a 256-bit random secret has no preimage worth
 * attacking — which is why a plain hash is right here and a password hash
 * (bcrypt/argon2) is not.
 */
import { createHash, randomBytes } from "node:crypto";

export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

const SECRET_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
const TENANT_PATTERN = /^[0-9a-f]{24}$/i;

export type ParsedRefreshToken = { tenantId: string; token: string };

export function generateRefreshToken(tenantId: string): string {
  return `${tenantId}.${randomBytes(32).toString("base64url")}`;
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Returns null rather than throwing: a malformed cookie is an ordinary 401 at
 * the route, not an exceptional condition, and the caller decides the wording.
 */
export function parseRefreshToken(value: string | null | undefined): ParsedRefreshToken | null {
  if (!value) return null;
  const separator = value.indexOf(".");
  if (separator < 0) return null;
  const tenantId = value.slice(0, separator);
  const secret = value.slice(separator + 1);
  if (!TENANT_PATTERN.test(tenantId) || !SECRET_PATTERN.test(secret)) return null;
  return { tenantId: tenantId.toLowerCase(), token: value };
}
