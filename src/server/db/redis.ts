import Redis from "ioredis";
import { env } from "@/env";

/**
 * Redis backs rate limiting, the JWT deny-list and meter caching
 * (docs/BACKEND.md §4). Same hot-reload caveat as the Mongo client.
 */
declare global {
  var __graftRedis: Redis | undefined;
}

export function getRedis(): Redis {
  if (!globalThis.__graftRedis) {
    globalThis.__graftRedis = new Redis(env().REDIS_URL, {
      maxRetriesPerRequest: 2,
      lazyConnect: false,
    });
  }
  return globalThis.__graftRedis;
}
