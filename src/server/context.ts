/**
 * The request context — the single value every service and repository call
 * carries (docs/BACKEND.md §1.2).
 *
 * PROTECTED PATH (.github/agent-policy.yml): this is one half of the tenant
 * isolation boundary. `ctx.tenantId` is the only tenant identity the data layer
 * will accept, so how a ctx comes into existence is a security decision, not a
 * convenience.
 *
 * This module is a leaf on purpose: it says what a Ctx *is* and validates one.
 * Building a Ctx from a request is authentication, and lives in
 * src/server/auth/session.ts (GRAFT-03.1).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
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
