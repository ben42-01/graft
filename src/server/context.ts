/**
 * The request context — the single value every service and repository call
 * carries (docs/BACKEND.md §1.2).
 *
 * PROTECTED PATH (.github/agent-policy.yml): this is one half of the tenant
 * isolation boundary. `ctx.tenantId` is the only tenant identity the data layer
 * will accept, so how a ctx comes into existence is a security decision, not a
 * convenience.
 *
 * Authentication is GRAFT-03. Until then `contextFromRequest` is an explicit
 * development stub, and it refuses to authenticate anyone in production.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "@/env";
import { AppError } from "@/server/http/envelope";
import { TIERS, type Tier } from "@/server/tiers";

export const ROLES = ["owner", "admin", "member"] as const;
export type Role = (typeof ROLES)[number];

/**
 * `tier` is carried from day one so entitlements (GRAFT-05) can call
 * `can(ctx, ...)` without changing a single service signature.
 */
export type Ctx = Readonly<{
  requestId: string;
  tenantId: string;
  userId: string;
  roles: readonly Role[];
  tier: Tier;
}>;

/** Ids are Mongo ObjectId hex — validated here so nothing unvetted reaches a query. */
const objectIdHex = z.string().regex(/^[0-9a-f]{24}$/i, "Expected a 24-character id");

const ctxSchema = z.object({
  requestId: z.string().min(1).max(64),
  tenantId: objectIdHex,
  userId: objectIdHex,
  roles: z.array(z.enum(ROLES)).min(1),
  tier: z.enum(TIERS),
});

/** A request id is echoed to the client and written into logs — keep it inert. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

export function newRequestId(): string {
  return randomUUID();
}

/**
 * Honour an upstream trace id when it is a sane token, so a request can be
 * followed across the edge; otherwise mint one. Never trust it verbatim — an
 * unfiltered header would let a caller forge log lines.
 */
export function requestIdFrom(request: Request): string {
  const inbound = request.headers.get("x-request-id");
  return inbound && REQUEST_ID_PATTERN.test(inbound) ? inbound : newRequestId();
}

export function createContext(fields: {
  requestId: string;
  tenantId: string;
  userId: string;
  roles: readonly Role[];
  tier: Tier;
}): Ctx {
  const parsed = ctxSchema.safeParse(fields);
  if (!parsed.success) {
    throw new AppError("UNAUTHORIZED", "Invalid request context");
  }
  return Object.freeze(parsed.data);
}

/**
 * The only environments in which a header may stand in for an identity. This is
 * an allow-list on purpose: the previous deny-list (`appEnv === "production"`)
 * meant every value it failed to anticipate — an unset variable, a typo, a new
 * environment name like "staging" — silently authenticated the caller.
 */
const STUB_ENVIRONMENTS: ReadonlySet<string> = new Set(["dev", "qa"]);

export type ContextOptions = {
  /**
   * The id `route()` already minted for this request. Passed in so one request
   * has exactly one id: without it the response and its log line disagreed.
   */
  requestId?: string;
  appEnv?: string;
  nodeEnv?: string;
};

/**
 * STUB (GRAFT-03 replaces this with RS256 token verification, docs/BACKEND.md §3.1).
 *
 * Reads the identity from `x-graft-*` headers so dev and the Bruno suite can
 * exercise tenant-scoped routes before auth exists. Trusting a header is exactly
 * the bypass this file is meant to prevent, so it is inert anywhere but dev and
 * qa: no token verification, no authenticated request.
 *
 * It **fails closed**. A deployment that forgets APP_ENV gets no authentication
 * at all, which is a loud outage; the alternative — the shape this code had
 * until GRAFT-02.1 — was handing any caller any tenant, which is a silent breach.
 */
export function contextFromRequest(request: Request, options: ContextOptions = {}): Ctx {
  const appEnv = options.appEnv ?? env().APP_ENV;
  // Node's own variable, read raw rather than through env(): a second, independent
  // signal that this is a production process, and one nothing here can default away.
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? "";

  if (!STUB_ENVIRONMENTS.has(appEnv) || nodeEnv === "production") {
    throw new AppError("UNAUTHORIZED", "Authentication is not available yet");
  }

  const header = (name: string) => request.headers.get(name)?.trim() ?? "";
  const roles = header("x-graft-roles")
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean);

  return createContext({
    requestId: options.requestId ?? requestIdFrom(request),
    tenantId: header("x-graft-tenant-id"),
    userId: header("x-graft-user-id"),
    roles: roles as Role[],
    tier: (header("x-graft-tier") || "free") as Tier,
  });
}
