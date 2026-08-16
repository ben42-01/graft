/**
 * The limiter port and its two implementations (docs/BACKEND.md §4).
 *
 * Redis is where the counters actually live (AC5) — two app instances share one
 * budget precisely because neither of them holds it. That makes the interesting
 * behaviour — fail open vs closed, charge-on-failure, header arithmetic —
 * untestable without infrastructure unless it is behind a port, so it is: the
 * decisions live in enforce.ts against `LimiterBackend`, and the two adapters
 * below are the thin part.
 *
 * The distinction the port exists to preserve: a *rejection* (budget spent) is a
 * normal outcome and returns `allowed: false`; an *outage* (Redis unreachable)
 * throws, and the caller decides which way to fail.
 */
import type { Redis } from "ioredis";
import {
  RateLimiterMemory,
  RateLimiterRedis,
  RateLimiterRes,
  type RateLimiterAbstract,
} from "rate-limiter-flexible";
import { getRedis } from "@/server/db/redis";
import type { ScopeLimit } from "./scopes";

export type ConsumeOutcome = {
  allowed: boolean;
  /** The ceiling that applied, for `X-RateLimit-Limit`. */
  limit: number;
  remaining: number;
  /** Milliseconds until the bucket refills, for `Retry-After` / `-Reset`. */
  msBeforeNext: number;
};

export type LimiterBackend = {
  /** Spend `points` (default 1) from the bucket. Throws only on an outage. */
  consume(key: string, limit: ScopeLimit, points?: number): Promise<ConsumeOutcome>;
  /** Read the bucket without spending from it. Throws only on an outage. */
  peek(key: string, limit: ScopeLimit): Promise<ConsumeOutcome>;
};

/** Keys already carry `rl:<scope>:`; this keeps them out of other tenancy of the DB. */
const KEY_PREFIX = "graft";

const shape = (limit: ScopeLimit, res: RateLimiterRes, allowed: boolean): ConsumeOutcome => ({
  allowed,
  limit: limit.points,
  remaining: Math.max(0, res.remainingPoints),
  msBeforeNext: res.msBeforeNext,
});

/**
 * One `RateLimiter*` per distinct bucket geometry, not per key: the library
 * instance carries the points/duration configuration, and the key is an
 * argument. Two scopes that happen to share a geometry stay independent because
 * their keys differ (see `keyFor`).
 */
function limiterCache<L extends RateLimiterAbstract>(build: (limit: ScopeLimit) => L) {
  const cache = new Map<string, L>();
  return (limit: ScopeLimit): L => {
    const id = `${limit.points}/${limit.durationSeconds}`;
    const existing = cache.get(id);
    if (existing) return existing;
    const created = build(limit);
    cache.set(id, created);
    return created;
  };
}

function backendOver(limiterFor: (limit: ScopeLimit) => RateLimiterAbstract): LimiterBackend {
  return {
    async consume(key, limit, points = 1) {
      try {
        return shape(limit, await limiterFor(limit).consume(key, points), true);
      } catch (error) {
        // A spent budget is an answer, not a failure. Anything else is an outage
        // and belongs to the caller's fail-open/closed decision (AC7).
        if (error instanceof RateLimiterRes) return shape(limit, error, false);
        throw error;
      }
    },
    async peek(key, limit) {
      const res = await limiterFor(limit).get(key);
      if (!res)
        return { allowed: true, limit: limit.points, remaining: limit.points, msBeforeNext: 0 };
      return shape(limit, res, res.consumedPoints < limit.points);
    },
  };
}

export function createRedisBackend(client: Redis): LimiterBackend {
  const limiterFor = limiterCache(
    (limit) =>
      new RateLimiterRedis({
        storeClient: client,
        keyPrefix: KEY_PREFIX,
        points: limit.points,
        duration: limit.durationSeconds,
      }),
  );
  return backendOver(limiterFor);
}

/** The production backend, over the shared ioredis client. */
let shared: LimiterBackend | null = null;

export function redisBackend(): LimiterBackend {
  if (!shared) shared = createRedisBackend(getRedis());
  return shared;
}

/**
 * In-process counters. Used by the unit tests, and never in a running app: an
 * in-memory limiter would give every instance its own budget, which is the exact
 * property AC5 exists to rule out.
 */
export function memoryBackend(): LimiterBackend {
  const limiterFor = limiterCache(
    (limit) =>
      new RateLimiterMemory({
        keyPrefix: KEY_PREFIX,
        points: limit.points,
        duration: limit.durationSeconds,
      }),
  );
  return backendOver(limiterFor);
}
