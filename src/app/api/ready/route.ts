import { getDb } from "@/server/db/mongo";
import { getRedis } from "@/server/db/redis";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";

/**
 * Readiness — can this instance actually serve traffic (docs/BACKEND.md §8).
 * Checks Mongo and Redis; 503 when either is down so the uptime checker and any
 * load balancer see the same truth.
 */
export const dynamic = "force-dynamic";

type Check = { ok: boolean; latencyMs: number; error?: string };

async function timed(fn: () => Promise<unknown>): Promise<Check> {
  const started = Date.now();
  try {
    await fn();
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : "unknown error",
    };
  }
}

export const GET = route(async (_request, { requestId }) => {
  const [mongo, redis] = await Promise.all([
    timed(async () => (await getDb()).command({ ping: 1 })),
    timed(async () => getRedis().ping()),
  ]);

  const ok = mongo.ok && redis.ok;
  return jsonOk(
    { status: ok ? "ready" : "degraded", checks: { mongo, redis } },
    requestId,
    undefined,
    { status: ok ? 200 : 503 },
  );
});
