/**
 * The platform-admin gate (GRAFT-27.1).
 * PROTECTED PATH (.github/agent-policy.yml: src/server/auth/**), approved for
 * this contract on issue #85.
 *
 * This is a *second* authorisation boundary, sitting beside tenant RBAC rather
 * than on top of it (docs/BACKEND.md §3.2). Three decisions are worth reading
 * before changing anything here.
 *
 * ## 1. It is not a role, and `Ctx` is not extended
 *
 * `Ctx` (src/server/context.ts) carries exactly one `tenantId` and `roles` that
 * are membership-scoped. A platform admin is neither: the privilege belongs to
 * a *person*, not to their seat in a workspace. Widening `ROLES` or adding a
 * field to `Ctx` would change the meaning of every tenant-scoped code path in
 * the product to express something none of them care about. So the actor lives
 * here, is produced by this function, and reaches nothing else.
 *
 * A platform admin still signs in through the ordinary login and still holds an
 * ordinary tenant session. `ctx` therefore exists on an admin request, and is
 * used for identity, logging and rate-limit accounting — and for nothing else.
 * **Admin reads must never be scoped by `ctx.tenantId`** (AC10).
 *
 * ## 2. The flag is re-read from the database on every request
 *
 * The access token (`accessClaimsSchema`, src/server/services/tokens.ts) is not
 * extended either. A privilege carried on a 15-minute token is a privilege you
 * cannot revoke for 15 minutes. `tokens.ts` already makes this argument for
 * re-reading roles on refresh, and `entitlements.ts` makes it for never
 * trusting `ctx.tier` for a grant; this is the same rule applied to the most
 * dangerous flag in the system. One extra `users` read by `_id` is a cheap
 * price for a revocation that takes effect on the next request (AC5).
 *
 * The comparison is `=== true`, never a truthiness check: a hand-edited
 * document or a sloppy import can easily produce `"true"`, `1` or `"false"`,
 * and every one of those is truthy in JavaScript (AC2).
 *
 * ## 3. A refusal is 404, not 403 — deliberately unlike the rest of the API
 *
 * Everywhere else, a caller who is authenticated but not allowed gets `403
 * FORBIDDEN` (docs/BACKEND.md §2; bruno/security/forbidden-cross-tenant.bru).
 * The admin surface diverges: it answers `404 NOT_FOUND`, with the *same*
 * message the /api/v1 catch-all produces for a path that does not exist. A 403
 * would tell an ordinary tenant user that `/api/v1/admin/*` is a real surface
 * worth attacking, and which of its paths are real. A 404 tells them nothing.
 * Matching the catch-all's wording is what makes that true in practice rather
 * than in intent — see bruno/security/admin-surface-is-not-an-oracle.bru.
 *
 * Denials are logged as `admin.denied` with `requestId` and `userId` only, and
 * write **no** audit row: `admin_audit_log` records actions taken, not attempts
 * (AC7, and see src/server/services/admin-audit.ts for why that matters).
 */
import type { Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import { createLogger, type Logger } from "@/server/log";
import { recordAdminAction, type AdminAuditStore } from "@/server/services/admin-audit";
import { mongoAccountStore, type AccountStore } from "./accounts-store";

/** The only thing a platform-admin route learns about its caller. */
export type PlatformAdminActor = Readonly<{
  userId: string;
  email: string;
  isPlatformAdmin: true;
}>;

export type PlatformAdminDeps = {
  accounts: Pick<AccountStore, "findUserById">;
  audit: Pick<AdminAuditStore, "append">;
};

export type AssertPlatformAdminOptions = {
  /** The request, so the refusal can name the path exactly as the catch-all does. */
  request: Request;
  /** The dotted verb written to the audit log on success, e.g. `admin.session.read`. */
  action: string;
  /** The tenant the action is about, when it is about one. Never a query filter. */
  targetTenantId?: string | null;
  /** The route's bound logger; a bare one is used in a direct call. */
  log?: Logger;
  /** Test seam. Production resolves both stores lazily. */
  deps?: Partial<PlatformAdminDeps>;
};

let defaultAccounts: AccountStore | undefined;
const accountStore = () => (defaultAccounts ??= mongoAccountStore());

/**
 * Word for word what src/app/api/v1/[...path]/route.ts says about a path no
 * route claims. Kept identical on purpose: the refusal below has to be
 * indistinguishable from "there is nothing here", or the 404 is only cosmetic.
 * platform-admin.test.ts pins the two against each other so drift in either
 * one fails the build.
 */
export function unroutedNotFound(request: Request): AppError {
  const { pathname } = new URL(request.url);
  return new AppError("NOT_FOUND", `No API route matches ${request.method} ${pathname}`);
}

/**
 * Re-read the caller's platform-admin flag and either return the actor or
 * refuse with a 404. On success, exactly one row is appended to
 * `admin_audit_log`; on refusal, exactly one `admin.denied` log line is written
 * and nothing is appended.
 *
 * Call this as the first statement of every `/api/v1/admin/*` handler, after
 * `await context()` and before anything else.
 */
export async function assertPlatformAdmin(
  ctx: Ctx,
  options: AssertPlatformAdminOptions,
): Promise<PlatformAdminActor> {
  const accounts = options.deps?.accounts ?? accountStore();
  const user = await accounts.findUserById(ctx.userId);

  // `=== true` and nothing looser: see the note on truthy near-misses above.
  if (!user || user.isPlatformAdmin !== true) {
    const log = options.log ?? createLogger();
    // AC7 — requestId + userId only. No email, no path, no roles: this line is
    // for correlation, and a denial is not evidence of anything about a person.
    log.warn("admin.denied", { requestId: ctx.requestId, userId: ctx.userId });
    throw unroutedNotFound(options.request);
  }

  await recordAdminAction(
    {
      actorUserId: user.id,
      action: options.action,
      targetTenantId: options.targetTenantId ?? null,
      requestId: ctx.requestId,
    },
    options.deps?.audit ? { audit: options.deps.audit } : {},
  );

  return Object.freeze({
    userId: user.id,
    email: user.email,
    isPlatformAdmin: true as const,
  });
}
