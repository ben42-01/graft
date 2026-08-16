/**
 * The rate-limit decision layer (docs/BACKEND.md §4).
 *
 * Given the scopes a route declared, the identity behind the request and a
 * backend, this answers three questions: is the request allowed, what does the
 * client get told about its budget, and what happens when Redis cannot be
 * reached. `route()` does the plumbing; every rule lives here.
 *
 * The one subtlety worth stating up front is the auth scope (AC3). Login is
 * limited on *failures*, not attempts: a correct password must never spend the
 * budget, or a busy legitimate user locks themselves out. So the auth scope is
 * *read* before the handler runs and *charged* afterwards, once the response
 * status says whether the credentials were accepted.
 */
import { AppError } from "@/server/http/envelope";
import type { Logger } from "@/server/log";
import type { Tier } from "@/server/tiers";
import { redisBackend, type ConsumeOutcome, type LimiterBackend } from "./backend";
import {
  OUTAGE_POLICY,
  keyFor,
  limitFor,
  resetEpochSeconds,
  retryAfterSeconds,
  type RateLimitScope,
  type ScopeIdentity,
} from "./scopes";

/** docs/BACKEND.md §4 — "1 MB JSON default". */
export const MAX_BODY_BYTES = 1_048_576;

export type EnforceInput = {
  request: Request;
  log: Logger;
  scopes: readonly RateLimitScope[];
  identity: ScopeIdentity;
  /** From the verified access token's `tier` claim, itself read from tenants.tier. */
  tier?: Tier;
};

export type EnforceDeps = { backend: LimiterBackend };

export type Blocked = {
  scope: RateLimitScope;
  retryAfterSeconds: number;
  /** True when the refusal came from an outage rather than a spent budget. */
  degraded?: boolean;
};

export type EnforceOutcome = {
  /** Lowercase header names, ready to copy onto a Response. */
  headers: Record<string, string>;
  blocked?: Blocked;
  /**
   * Present when a charge-on-failure scope applied. Call it with the status the
   * handler produced; a rejection spends a point, a success spends nothing.
   */
  recordOutcome?: (status: number) => Promise<void>;
};

const resolve = (overrides: Partial<EnforceDeps> = {}): EnforceDeps => ({
  backend: overrides.backend ?? redisBackend(),
});

/** Statuses that mean "those credentials were not accepted" (AC3). */
const CREDENTIAL_REJECTIONS = new Set([401, 403]);

/** Scopes charged only when the handler rejects the request. */
const CHARGE_ON_FAILURE: ReadonlySet<RateLimitScope> = new Set<RateLimitScope>(["auth"]);

const headersFor = (outcome: ConsumeOutcome, blocked: boolean): Record<string, string> => ({
  "x-ratelimit-limit": String(outcome.limit),
  "x-ratelimit-remaining": String(outcome.remaining),
  "x-ratelimit-reset": String(resetEpochSeconds(outcome.msBeforeNext)),
  ...(blocked ? { "retry-after": String(retryAfterSeconds(outcome.msBeforeNext)) } : {}),
});

export async function enforceRateLimit(
  input: EnforceInput,
  overrides: Partial<EnforceDeps> = {},
): Promise<EnforceOutcome> {
  const { backend } = resolve(overrides);
  const { log, tier } = input;

  /** The tightest budget seen, which is the one worth reporting to the client. */
  let tightest: ConsumeOutcome | null = null;
  let chargeable: { key: string; scope: RateLimitScope } | null = null;

  for (const scope of input.scopes) {
    const key = keyFor(scope, input.identity);
    // No identity for this scope — an unauthenticated request has no tenant.
    // Skipped rather than bucketed together; see keyFor.
    if (!key) continue;

    const limit = limitFor(scope, tier);
    const charged = CHARGE_ON_FAILURE.has(scope);

    let outcome: ConsumeOutcome;
    try {
      outcome = charged ? await backend.peek(key, limit) : await backend.consume(key, limit);
    } catch (error) {
      // AC7 — an unreachable Redis. Scope, decision and cause; never the key,
      // which carries the caller's address.
      const decision = OUTAGE_POLICY[scope];
      log.warn("ratelimit.degraded", { scope, decision, error });
      if (decision === "open") continue;
      return {
        headers: {
          "x-ratelimit-limit": String(limit.points),
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetEpochSeconds(limit.durationSeconds * 1000)),
          "retry-after": String(limit.durationSeconds),
        },
        blocked: { scope, retryAfterSeconds: limit.durationSeconds, degraded: true },
      };
    }

    if (!outcome.allowed) {
      log.warn("ratelimit.blocked", { scope, limit: outcome.limit });
      return {
        headers: headersFor(outcome, true),
        blocked: { scope, retryAfterSeconds: retryAfterSeconds(outcome.msBeforeNext) },
      };
    }

    if (charged) chargeable = { key, scope };
    if (!tightest || outcome.remaining < tightest.remaining) tightest = outcome;
  }

  const headers = tightest ? headersFor(tightest, false) : {};
  if (!chargeable) return { headers };

  const charge = chargeable;
  return {
    headers,
    recordOutcome: async (status: number) => {
      if (!CREDENTIAL_REJECTIONS.has(status)) return;
      try {
        await backend.consume(charge.key, limitFor(charge.scope, tier));
      } catch (error) {
        // The attempt is already answered; a limiter that cannot record it must
        // not turn a 401 into a 500.
        log.warn("ratelimit.degraded", {
          scope: charge.scope,
          decision: OUTAGE_POLICY[charge.scope],
          phase: "record",
          error,
        });
      }
    },
  };
}

/**
 * AC6 — the declared size is checked before the handler is entered, so an
 * oversized body is refused rather than buffered. A request that declares no
 * length is not assumed to be empty; it is simply not judged here, and the Zod
 * boundary is what stands between it and a service.
 */
export function assertBodyWithinLimit(request: Request, maxBytes = MAX_BODY_BYTES): void {
  const declared = request.headers.get("content-length");
  if (declared === null) return;
  const bytes = Number(declared);
  if (!Number.isFinite(bytes)) return;
  if (bytes > maxBytes) {
    throw new AppError("PAYLOAD_TOO_LARGE", `Request body exceeds ${maxBytes} bytes`, {
      maxBytes,
    });
  }
}
