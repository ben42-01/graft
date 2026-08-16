import Redis from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { createRedisBackend, type LimiterBackend } from "./backend";
import { keyFor, limitFor, type ScopeLimit } from "./scopes";

/**
 * AC5 — the counters live in Redis, not in the process. Two limiter instances
 * built over two separate connections stand in for two app instances, and a
 * connection replaced mid-test stands in for a restart.
 *
 * Runs against the QA Redis (docker/docker-compose.qa.yml, :6380) or whatever
 * REDIS_URL points at. CI runs `npm run test:integration` before `npm run qa:db`
 * — see .github/workflows/ci.yml, a protected path this issue may not reorder —
 * so there the stack is not up yet and this file reports itself as *skipped*
 * rather than passing vacuously on absent infrastructure. It runs for real in
 * `npm run verify:full` with the QA stack up, and the same property is covered
 * end-to-end over the live app by bruno/security/rate-limit-429.bru.
 */

const URL_CANDIDATES = [
  process.env.REDIS_URL,
  "redis://127.0.0.1:6380",
  "redis://127.0.0.1:6379",
];

const connect = async (url: string): Promise<Redis | null> => {
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 750,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  try {
    await client.connect();
    await client.ping();
    return client;
  } catch {
    client.disconnect();
    return null;
  }
};

const found = await (async () => {
  for (const candidate of URL_CANDIDATES) {
    if (!candidate) continue;
    const client = await connect(candidate);
    if (client) return { url: candidate, client };
  }
  return null;
})();

if (!found) {
  console.warn(
    `[rate-limit] no Redis on ${URL_CANDIDATES.filter(Boolean).join(", ")} — ` +
      "shared-budget integration test skipped (start it with `npm run qa:db`)",
  );
}

const clientA = found?.client ?? null;
const clientB = found ? await connect(found.url) : null;

afterAll(async () => {
  for (const client of [clientA, clientB]) {
    if (client) await client.quit().catch(() => client.disconnect());
  }
});

/** A unique suffix per run, so a rerun against a warm Redis starts clean. */
const unique = () => `it${Date.now()}${Math.floor(Math.random() * 1e6)}`;

const spend = async (
  backend: LimiterBackend,
  key: string,
  limit: ScopeLimit,
  times: number,
) => {
  const outcomes = [];
  for (let i = 0; i < times; i += 1) outcomes.push(await backend.consume(key, limit));
  return outcomes;
};

describe.skipIf(!clientA || !clientB)("Redis-backed limiter", () => {
  it("shares one budget across two limiter instances (AC5)", async () => {
    const backendA = createRedisBackend(clientA!);
    const backendB = createRedisBackend(clientB!);
    const limit: ScopeLimit = { points: 5, durationSeconds: 60 };
    const key = `rl:test:${unique()}`;

    const first = await spend(backendA, key, limit, 3);
    expect(first.at(-1)?.remaining).toBe(2);

    // A different instance, a different connection, the same budget.
    const second = await spend(backendB, key, limit, 2);
    expect(second.at(-1)?.remaining).toBe(0);

    const blocked = await backendB.consume(key, limit);
    expect(blocked.allowed).toBe(false);
    expect(blocked.msBeforeNext).toBeGreaterThan(0);

    // And the instance that spent the first three agrees it is out.
    expect((await backendA.consume(key, limit)).allowed).toBe(false);
  });

  it("survives a process restart (AC5)", async () => {
    const limit: ScopeLimit = { points: 4, durationSeconds: 60 };
    const key = `rl:test:${unique()}`;
    await spend(createRedisBackend(clientA!), key, limit, 3);

    // Everything in-process is thrown away, exactly as a redeploy would.
    const restarted = await connect(found!.url);
    expect(restarted).not.toBeNull();
    try {
      const after = await createRedisBackend(restarted!).consume(key, limit);
      expect(after.allowed).toBe(true);
      expect(after.remaining).toBe(0);
      expect((await createRedisBackend(restarted!).consume(key, limit)).allowed).toBe(false);
    } finally {
      await restarted!.quit().catch(() => restarted!.disconnect());
    }
  });

  it("keeps one tenant's exhaustion off another tenant's budget (AC4)", async () => {
    const backend = createRedisBackend(clientA!);
    const limit = limitFor("api", "free");
    const run = unique();
    const keyA = `${keyFor("api", { tenantId: "000000000000000000000001" })}:${run}`;
    const keyB = `${keyFor("api", { tenantId: "000000000000000000000002" })}:${run}`;

    await spend(backend, keyA, limit, limit.points);
    expect((await backend.consume(keyA, limit)).allowed).toBe(false);
    expect((await backend.consume(keyB, limit)).allowed).toBe(true);
  });

  it("keeps scopes independent in the keyspace (AC4)", async () => {
    const backend = createRedisBackend(clientA!);
    const limit = limitFor("public-form");
    const run = unique();
    const formKey = `${keyFor("public-form", { ip: "203.0.113.7", formId: "contact" })}:${run}`;
    const ipKey = `${keyFor("global-ip", { ip: "203.0.113.7" })}:${run}`;

    await spend(backend, formKey, limit, limit.points);
    expect((await backend.consume(formKey, limit)).allowed).toBe(false);
    expect((await backend.consume(ipKey, limitFor("global-ip"))).allowed).toBe(true);
  });
});
