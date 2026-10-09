/**
 * Read-only lookups for customer support — `ops support <env> user|tenant|find`.
 *
 *   tsx devops/lib/support.ts user   <email>                   [--json]
 *   tsx devops/lib/support.ts tenant <id | slug | owner email> [--json]
 *   tsx devops/lib/support.ts find   <collection> '<filter>' [--limit N] [--json]
 *
 * Three rules, the same ones the admin console follows (src/server/services/
 * admin-users.ts):
 *
 *  1. **Read-only.** Connects as SUPPORT_MONGODB_URI — a user holding only the
 *     `read` role, created by `ops support <env> grant-readonly` — and falls back
 *     to the app user with a warning. Nothing below writes, even on that fallback.
 *  2. **Secrets never print.** Any field whose name says hash, token, secret or
 *     password is replaced before output, at any depth.
 *  3. **Bounded.** Fixed collection allow-list, a hard result cap, and no
 *     server-side JavaScript operators in a filter.
 *
 * Personal data (emails, names, submission contents) *is* shown: finding the
 * person who wrote in is the point. It goes to the operator's terminal only,
 * and `ops` writes an audit line for every call (who, when, what was asked).
 */
import { BSON, MongoClient, ObjectId, type Db, type Document } from "mongodb";
import { pathToFileURL } from "node:url";
import { COLLECTIONS, dbNameFromUri } from "../../scripts/lib/db";

const MAX_LIMIT = 200;
// Field names that *end* in one of these: tokenHash, passwordHash, apiKey,
// accessToken. Not `refresh_tokens` — that is a collection name in a count.
const SECRET_FIELD = /(hash|token|secret|password|apikey)$/i;
const FORBIDDEN_OPERATORS = new Set(["$where", "$function", "$accumulator", "$expr"]);
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const { EJSON } = BSON;

const args = process.argv.slice(2);
const json = args.includes("--json");
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--limit");

// ── Output ────────────────────────────────────────────────────────────────────

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof ObjectId || value instanceof Date) return value;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SECRET_FIELD.test(k) ? "[redacted]" : redact(v),
      ]),
    );
  }
  return value;
}

function emit(result: unknown) {
  if (json) {
    console.log(EJSON.stringify(redact(result), undefined, 2, { relaxed: true }));
    return;
  }
  printTree(redact(result), 0);
}

function scalar(v: unknown): string {
  if (v instanceof ObjectId) return v.toHexString();
  if (v instanceof Date) return v.toISOString().replace(".000Z", "Z");
  if (v === null || v === undefined) return "—";
  return typeof v === "string" ? v : EJSON.stringify(v as Document, { relaxed: true });
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  !(v instanceof ObjectId) &&
  !(v instanceof Date);

/** A list of flat rows (activity, orders) reads best as a table. */
function printTable(rows: Record<string, unknown>[], pad: string) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cells = rows.map((r) => cols.map((c) => scalar(r[c])));
  const widths = cols.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i].length)));
  const line = (vals: string[]) =>
    pad +
    vals
      .map((v, i) => v.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  console.log(line(cols));
  for (const row of cells) console.log(line(row));
}

function printTree(value: unknown, depth: number) {
  const pad = "  ".repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) console.log(`${pad}(none)`);
    if (value.length > 0 && value.every((r) => isPlain(r) && !Object.values(r).some(isPlain))) {
      return printTable(value as Record<string, unknown>[], pad);
    }
    for (const item of value) {
      if (
        item &&
        typeof item === "object" &&
        !(item instanceof ObjectId) &&
        !(item instanceof Date)
      ) {
        printTree(item, depth);
        console.log();
      } else console.log(`${pad}- ${scalar(item)}`);
    }
    return;
  }
  if (
    value &&
    typeof value === "object" &&
    !(value instanceof ObjectId) &&
    !(value instanceof Date)
  ) {
    const width = Math.max(...Object.keys(value).map((k) => k.length), 0);
    for (const [k, v] of Object.entries(value)) {
      const nested =
        v && typeof v === "object" && !(v instanceof ObjectId) && !(v instanceof Date);
      if (nested && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0)) {
        console.log(`${pad}${k}:`);
        printTree(v, depth + 1);
      } else {
        console.log(
          `${pad}${k.padEnd(width)}  ${nested ? (Array.isArray(v) ? "[]" : "{}") : scalar(v)}`,
        );
      }
    }
    return;
  }
  console.log(`${pad}${scalar(value)}`);
}

// ── Lookups ───────────────────────────────────────────────────────────────────

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : (d ?? null));

async function userLookup(db: Db, email: string) {
  const user = await db.collection("users").findOne({ email: email.trim().toLowerCase() });
  if (!user) return { found: false, email };
  const tenantIds = (user.memberships ?? []).map((m: { tenantId: ObjectId }) => m.tenantId);
  const tenants = await db
    .collection("tenants")
    .find({ _id: { $in: tenantIds } }, { projection: { name: 1, slug: 1, tier: 1 } })
    .toArray();
  const byId = new Map(tenants.map((t) => [t._id.toHexString(), t]));
  const now = new Date();
  const [activeSessions, recent] = await Promise.all([
    db.collection("refresh_tokens").countDocuments({
      userId: user._id,
      revokedAt: null,
      usedAt: null,
      expiresAt: { $gt: now },
    }),
    db
      .collection("activities")
      .find({ actorId: user._id })
      .sort({ at: -1 })
      .limit(10)
      .project({ _id: 0, at: 1, action: 1, ok: 1, tenantId: 1, requestId: 1 })
      .toArray(),
  ]);
  return {
    found: true,
    id: user._id,
    email: user.email,
    name: user.name ?? null,
    emailVerified: Boolean(user.emailVerifiedAt),
    emailVerifiedAt: iso(user.emailVerifiedAt),
    platformAdmin: user.isPlatformAdmin === true,
    passwordSet: Boolean(user.passwordHash),
    createdAt: iso(user.createdAt),
    activeSessions,
    memberships: (user.memberships ?? []).map((m: { tenantId: ObjectId; roles?: string[] }) => {
      const t = byId.get(m.tenantId.toHexString());
      return {
        tenantId: m.tenantId,
        tenant: t?.name ?? "(missing tenant)",
        slug: t?.slug ?? null,
        tier: t?.tier ?? null,
        roles: (m.roles ?? []).join(", "),
      };
    }),
    recentActivity: recent,
  };
}

async function resolveTenant(db: Db, query: string) {
  const tenants = db.collection("tenants");
  if (OBJECT_ID.test(query)) return tenants.findOne({ _id: new ObjectId(query) });
  if (query.includes("@")) {
    const user = await db.collection("users").findOne({ email: query.trim().toLowerCase() });
    const owned = user?.memberships?.find((m: { roles?: string[] }) =>
      m.roles?.includes("owner"),
    );
    const first = owned ?? user?.memberships?.[0];
    return first ? tenants.findOne({ _id: first.tenantId }) : null;
  }
  return tenants.findOne({ slug: query.trim().toLowerCase() });
}

async function tenantLookup(db: Db, query: string) {
  const tenant = await resolveTenant(db, query);
  if (!tenant) return { found: false, query };
  const tenantId = tenant._id as ObjectId;

  const members = await db
    .collection("users")
    .find(
      { "memberships.tenantId": tenantId },
      { projection: { email: 1, name: 1, emailVerifiedAt: 1, memberships: 1 } },
    )
    .toArray();

  // Every tenant-scoped collection, counted. Soft-deleted rows separately:
  // "my record vanished" is usually a deletedAt, not data loss.
  const counts: Record<string, string> = {};
  for (const name of COLLECTIONS) {
    if (name === "tenants" || name === "users") continue;
    const c = db.collection(name);
    const total = await c.countDocuments({ tenantId });
    if (total === 0) continue;
    const deleted = await c.countDocuments({ tenantId, deletedAt: { $ne: null } });
    counts[name] = deleted ? `${total} (${deleted} deleted)` : String(total);
  }

  const [activity, orders] = await Promise.all([
    db
      .collection("activities")
      .find({ tenantId })
      .sort({ at: -1 })
      .limit(15)
      .project({ _id: 0, at: 1, action: 1, ok: 1, actorType: 1, actorId: 1, requestId: 1 })
      .toArray(),
    db
      .collection("orders")
      .find({ tenantId })
      .sort({ createdAt: -1 })
      .limit(5)
      .project({ status: 1, currency: 1, totalMinor: 1, amountPaidMinor: 1, createdAt: 1 })
      .toArray(),
  ]);

  return {
    found: true,
    id: tenantId,
    name: tenant.name,
    slug: tenant.slug,
    tier: tenant.tier,
    createdAt: iso(tenant.createdAt),
    settings: tenant.settings ?? null,
    billing: tenant.billing ?? null,
    stripeConnect: tenant.stripeConnect ?? null,
    payment: tenant.payment ?? tenant.payments ?? null,
    members: members.map((u) => ({
      id: u._id,
      email: u.email,
      name: u.name ?? null,
      verified: Boolean(u.emailVerifiedAt),
      roles: (u.memberships ?? [])
        .filter((m: { tenantId: ObjectId }) => m.tenantId.equals(tenantId))
        .flatMap((m: { roles?: string[] }) => m.roles ?? [])
        .join(", "),
    })),
    counts,
    recentOrders: orders,
    recentActivity: activity,
  };
}

/** 24-hex strings under `_id` or any `…Id` key become ObjectIds. */
export function coerceIds(value: unknown, key = ""): unknown {
  if (
    typeof value === "string" &&
    OBJECT_ID.test(value) &&
    (key === "_id" || /Id$/.test(key))
  ) {
    return new ObjectId(value);
  }
  if (Array.isArray(value)) return value.map((v) => coerceIds(v, key));
  if (
    value &&
    typeof value === "object" &&
    !(value instanceof ObjectId) &&
    !(value instanceof Date)
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        if (FORBIDDEN_OPERATORS.has(k))
          throw new Error(`operator ${k} is not allowed in support queries`);
        // `$in: [...]` under tenantId keeps the parent key so its ids coerce too.
        return [k, coerceIds(v, k.startsWith("$") ? key : k)];
      }),
    );
  }
  return value;
}

async function find(db: Db, collection: string, filterText = "{}") {
  const allowed: readonly string[] = [...COLLECTIONS, "_migrations"];
  if (!allowed.includes(collection)) {
    throw new Error(`unknown collection '${collection}' — one of: ${allowed.join(", ")}`);
  }
  const limitArg = args[args.indexOf("--limit") + 1];
  const limit = Math.min(args.includes("--limit") ? Number(limitArg) || 20 : 20, MAX_LIMIT);
  const filter = coerceIds(EJSON.parse(filterText, { relaxed: false })) as Document;
  const docs = await db
    .collection(collection)
    .find(filter)
    .sort({ _id: -1 })
    .limit(limit)
    .toArray();
  const total = await db.collection(collection).countDocuments(filter);
  return { collection, filter: filterText, shown: docs.length, matched: total, docs };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [command, a, b] = positional;
  const supportUri = process.env.SUPPORT_MONGODB_URI;
  const uri = supportUri || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  if (!supportUri) {
    console.error(
      "[ops] warning: no SUPPORT_MONGODB_URI — reading as the app user (read-write). Run `ops support <env> grant-readonly`.",
    );
  }
  // Reads only; the URI's own database is the app database.
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5_000,
    appName: "graft-support",
  });
  await client.connect();
  try {
    const db = client.db(dbNameFromUri(process.env.MONGODB_URI ?? uri));
    switch (command) {
      case "user":
        if (!a) throw new Error("usage: user <email>");
        return emit(await userLookup(db, a));
      case "tenant":
        if (!a) throw new Error("usage: tenant <id | slug | owner email>");
        return emit(await tenantLookup(db, a));
      case "find":
        if (!a) throw new Error("usage: find <collection> '<json filter>' [--limit N]");
        return emit(await find(db, a, b));
      default:
        throw new Error("usage: support.ts user|tenant|find ...");
    }
  } finally {
    await client.close();
  }
}

// Only when executed (`tsx devops/lib/support.ts …`), not when a test imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[ops] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
