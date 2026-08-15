/**
 * Guards that stop a destructive local script from ever touching a hosted
 * database. Pure and dependency-free so it can be unit tested without a DB.
 *
 * docs/WORKFLOW.md §5.3 · docs/GO-LIVE.md §2 ("reset-db.ts guard verified")
 */

/** Hosts that are never acceptable targets for a destructive operation. */
const HOSTED_PATTERNS = [
  /\.mongodb\.net$/i, // Atlas
  /\.mongodb-dev\.net$/i,
  /\.docdb\.amazonaws\.com$/i, // DocumentDB
  /\.cosmos\.azure\.com$/i,
  /\.mongo\.ondigitalocean\.com$/i,
];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "mongo"]);

export type GuardResult = { safe: true } | { safe: false; reason: string };

/** Extract hostnames from a mongodb:// or mongodb+srv:// URI (may list several). */
export function hostsFromUri(uri: string): string[] {
  const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/i.exec(uri.trim());
  if (!match) return [];
  return match[1]
    .split(",")
    .map((hostPort) => hostPort.replace(/:\d+$/, "").trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Decide whether a destructive operation may run against this URI.
 *
 * Fails closed: an unparseable URI, an SRV connection string, a non-local host,
 * or NODE_ENV=production all refuse. Being wrong in the safe direction costs a
 * developer thirty seconds; being wrong the other way costs a database.
 */
export function assertDestructiveTargetIsLocal(
  uri: string | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): GuardResult {
  if (!uri) return { safe: false, reason: "MONGODB_URI is not set" };

  if (nodeEnv === "production") {
    return { safe: false, reason: "NODE_ENV=production" };
  }

  if (/^mongodb\+srv:/i.test(uri)) {
    return {
      safe: false,
      reason: "URI uses mongodb+srv:// — that is a hosted cluster, never a local one",
    };
  }

  const hosts = hostsFromUri(uri);
  if (hosts.length === 0) {
    return { safe: false, reason: "MONGODB_URI could not be parsed" };
  }

  for (const host of hosts) {
    const hosted = HOSTED_PATTERNS.find((p) => p.test(host));
    if (hosted) return { safe: false, reason: `host '${host}' is a managed cluster` };
    if (!LOCAL_HOSTS.has(host)) {
      return { safe: false, reason: `host '${host}' is not a known local host` };
    }
  }

  return { safe: true };
}
