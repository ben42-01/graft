/**
 * The rate-limit scope table (docs/BACKEND.md §4) as pure data.
 *
 * Everything here is a decision with no I/O in it: which limit applies, what a
 * bucket is keyed on, what the client is told to do next, and what happens if
 * Redis cannot answer. Keeping it separate from the limiter means the numbers
 * that matter are testable without a database and readable without following a
 * call chain.
 *
 * Two rules the rest of the module depends on:
 *
 *   - **A key always names its scope.** `rl:<scope>:...` — so exhausting one
 *     budget can never touch another (AC4), by construction rather than by
 *     convention.
 *   - **No raw identity in a key.** Email addresses are hashed before they reach
 *     Redis; a key dump is not a user list.
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { Tier } from "@/server/tiers";

export const RATE_LIMIT_SCOPES = [
  "global-ip",
  "auth",
  "api",
  "user",
  "public-form",
  "connector",
] as const;

export type RateLimitScope = (typeof RATE_LIMIT_SCOPES)[number];

/** A token bucket: `points` requests per `durationSeconds`. */
export type ScopeLimit = { points: number; durationSeconds: number };

const MINUTE = 60;

/** The untiered rows of the §4 table. */
export const FIXED_LIMITS: Record<"global-ip" | "auth" | "user" | "public-form", ScopeLimit> = {
  "global-ip": { points: 300, durationSeconds: MINUTE },
  // "5 login attempts / 15 min" — see enforce.ts: only *failures* are charged.
  auth: { points: 5, durationSeconds: 15 * MINUTE },
  user: { points: 120, durationSeconds: MINUTE },
  "public-form": { points: 10, durationSeconds: MINUTE },
};

/**
 * The tiered rows. Free and Premium are fixed by AC2; Enterprise is "custom" in
 * the spec and this is the default it starts from — a per-tenant override
 * belongs on the tenant document alongside the other Enterprise overrides
 * (docs/TIERS.md §2.1), which is GRAFT-05's ground, not this issue's.
 */
export const TIER_API_LIMITS: Record<Tier, ScopeLimit> = {
  free: { points: 60, durationSeconds: MINUTE },
  premium: { points: 600, durationSeconds: MINUTE },
  enterprise: { points: 6_000, durationSeconds: MINUTE },
};

/** Connectors are machine traffic on the same tier ladder, at half the ceiling. */
export const TIER_CONNECTOR_LIMITS: Record<Tier, ScopeLimit> = {
  free: { points: 30, durationSeconds: MINUTE },
  premium: { points: 300, durationSeconds: MINUTE },
  enterprise: { points: 3_000, durationSeconds: MINUTE },
};

/**
 * Which way each scope falls when Redis cannot answer (AC7).
 *
 * The contract names two of these: the public form fails **closed**, because it
 * is the only unauthenticated write surface in the product and an outage there
 * is an open door; authenticated traffic fails **open**, because throttling
 * paying tenants to zero over an infrastructure blip is a self-inflicted outage.
 *
 * `auth` is closed by the same reasoning as the public form — an unmetered login
 * endpoint is an offline password-guessing oracle — and `global-ip` is open,
 * because closing it would turn one unreachable Redis into a total blackout of
 * the API. Both are judgement calls the contract did not spell out; they are
 * recorded here so they can be argued with in one place.
 */
export const OUTAGE_POLICY: Record<RateLimitScope, "open" | "closed"> = {
  "global-ip": "open",
  auth: "closed",
  api: "open",
  user: "open",
  "public-form": "closed",
  connector: "open",
};

/** Tier-derived scopes with no known tier take the most restrictive row. */
const FALLBACK_TIER: Tier = "free";

export function limitFor(scope: RateLimitScope, tier?: Tier): ScopeLimit {
  switch (scope) {
    case "api":
      return TIER_API_LIMITS[tier ?? FALLBACK_TIER];
    case "connector":
      return TIER_CONNECTOR_LIMITS[tier ?? FALLBACK_TIER];
    default:
      return FIXED_LIMITS[scope];
  }
}

/** Everything a key can be derived from. Every field is optional by design. */
export type ScopeIdentity = {
  ip?: string | null;
  email?: string | null;
  tenantId?: string | null;
  userId?: string | null;
  formId?: string | null;
  tokenId?: string | null;
};

/** Short, stable, and not reversible into an address. */
const fingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

const normaliseEmail = (email: string): string => email.trim().toLowerCase();

/**
 * The bucket this request belongs to, or null when the identity the scope needs
 * is not available — an unauthenticated request has no tenant, and inventing a
 * placeholder would merge every such caller into one shared budget.
 */
export function keyFor(scope: RateLimitScope, identity: ScopeIdentity): string | null {
  const at = (...parts: Array<string | null | undefined>) =>
    parts.every((part) => part) ? `rl:${scope}:${parts.join(":")}` : null;

  switch (scope) {
    case "global-ip":
      return at(identity.ip);
    case "auth":
      return identity.ip && identity.email
        ? at(identity.ip, fingerprint(normaliseEmail(identity.email)))
        : null;
    case "api":
      return at(identity.tenantId);
    case "user":
      return at(identity.userId);
    case "public-form":
      return at(identity.ip, identity.formId);
    case "connector":
      return at(identity.tokenId);
  }
}

/**
 * The shared bucket for a request whose origin we cannot parse. Never null: a
 * caller must not be able to escape the IP scope by mangling the header, and
 * never a per-request value either, or garbage would mint unlimited buckets.
 */
export const UNKNOWN_IP = "unknown";

/**
 * The caller's address, as far as the edge will tell us.
 *
 * Constraint ("never key a limit on a client-supplied header alone"): a
 * forwarding header is only ever trusted for the *IP* scopes, which are the
 * coarse outer layer; every scope that governs real access — tenant, user,
 * connector — is keyed on a value taken from a signature we verified. The
 * validation below is the second half of that: an unparseable value collapses to
 * one shared bucket instead of a fresh one.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const candidate =
    forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip")?.trim();
  if (!candidate) return UNKNOWN_IP;

  const bracketed = candidate.match(/^\[(.+)\](?::\d+)?$/);
  const bare = bracketed ? bracketed[1] : candidate.replace(/:\d+$/, "");
  if (isIP(bare)) return bare;
  // A bare IPv6 has colons of its own; the port strip above would have cut it.
  return isIP(candidate) ? candidate : UNKNOWN_IP;
}

/** Whole seconds, and never "try again now" — a zero would be a busy loop. */
export const retryAfterSeconds = (msBeforeNext: number): number =>
  Math.max(1, Math.ceil(msBeforeNext / 1000));

/** `X-RateLimit-Reset` as an epoch second, the form clients already parse. */
export const resetEpochSeconds = (msBeforeNext: number, now = Date.now()): number =>
  Math.ceil((now + Math.max(0, msBeforeNext)) / 1000);
