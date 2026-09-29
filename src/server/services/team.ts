/**
 * The owner's side of a team (GRAFT-33.1): invite links, the member list, and
 * removing people. Accepting an invite is GRAFT-33.2.
 *
 *   - **Owner only, checked first.** Every function here refuses an `admin` or
 *     `member` with FORBIDDEN before it parses input or reads anything (AC4).
 *     Tenant role `admin` is shown as "Manager" in the product and grants
 *     nothing on the platform-admin console (src/server/auth/platform-admin.ts).
 *   - **An invite is a link, not an email.** The raw token is 32 random bytes,
 *     returned once inside `url` and never stored: `invites.tokenHash` is its
 *     SHA-256, the same treatment email-verification tokens get (AC1).
 *   - **Seats are counted, not metered.** `used` is this tenant's members plus
 *     its pending invites (unexpired, unrevoked, unaccepted), against the
 *     resolved `seats` entitlement. A pending invite holds a seat so an owner
 *     cannot hand out more links than the plan has room for (AC3).
 *
 * Invites go through the tenant-scoped repository. Members live on the global
 * `users` collection (a user's `memberships` array), which the repository layer
 * cannot express, so they are read through a narrow store below that always
 * filters by the caller's own `ctx.tenantId` and projects only email and
 * memberships — never a password hash.
 */
import { createHash, randomBytes } from "node:crypto";
import { ObjectId, type WithId } from "mongodb";
import { z } from "zod";
import { env } from "@/env";
import { ROLES, type Ctx, type Role } from "@/server/context";
import { getDb } from "@/server/db/mongo";
import { AppError } from "@/server/http/envelope";
import { parse } from "@/server/http/validate";
import { createLogger } from "@/server/log";
import { createRepository, type Repository } from "@/server/repositories/base";
import { mongoAccountStore, type AccountStore } from "@/server/auth/accounts-store";
import { limitFor, loadEntitlements, type Entitlements } from "./entitlements";

export const INVITE_ROLES = ["admin", "member"] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const objectIdHex = z.string().regex(/^[0-9a-f]{24}$/i, "Expected a 24-character id");

/** AC2 — `owner` is not an option, and unknown fields are refused, not dropped. */
export const createInviteSchema = z
  .object({
    role: z.enum(INVITE_ROLES),
    email: z.string().trim().toLowerCase().email().max(254).optional(),
  })
  .strict();

export type InviteDoc = {
  tenantId: ObjectId;
  role: InviteRole;
  email: string | null;
  tokenHash: string;
  createdBy: ObjectId;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
};

export type TeamMember = { userId: string; email: string; roles: Role[] };

export type InviteView = {
  id: string;
  role: InviteRole;
  email: string | null;
  expiresAt: string;
};

export type TeamView = {
  members: (TeamMember & { isYou: boolean })[];
  invites: InviteView[];
  seats: { used: number; limit: number | null };
};

export type MemberStore = { listMembers(tenantId: string): Promise<TeamMember[]> };

export type TeamDeps = {
  invites: Repository<InviteDoc>;
  members: MemberStore;
  accounts: Pick<AccountStore, "removeMembership">;
  entitlements: (ctx: Ctx) => Promise<Entitlements>;
  appUrl: () => string;
  now: () => Date;
};

type UserDoc = {
  _id: ObjectId;
  email: string;
  memberships?: { tenantId: ObjectId; roles: string[] }[];
};

/** Scoped by the tenant id it is handed, which is only ever `ctx.tenantId`. */
export function mongoMemberStore(): MemberStore {
  return {
    async listMembers(tenantId) {
      const tid = new ObjectId(tenantId);
      const users = await (
        await getDb()
      )
        .collection<UserDoc>("users")
        .find({ "memberships.tenantId": tid }, { projection: { email: 1, memberships: 1 } })
        .sort({ _id: 1 })
        .toArray();
      return users.map((user) => ({
        userId: user._id.toHexString(),
        email: user.email,
        roles:
          (user.memberships ?? [])
            .find((m) => m.tenantId.equals(tid))
            ?.roles.filter((r): r is Role => (ROLES as readonly string[]).includes(r)) ?? [],
      }));
    },
  };
}

const defaultInvites = createRepository<InviteDoc>("invites");

function resolveDeps(overrides: Partial<TeamDeps> = {}): TeamDeps {
  return {
    invites: overrides.invites ?? defaultInvites,
    members: overrides.members ?? mongoMemberStore(),
    accounts: overrides.accounts ?? mongoAccountStore(),
    entitlements: overrides.entitlements ?? loadEntitlements,
    appUrl: overrides.appUrl ?? (() => env().APP_URL),
    now: overrides.now ?? (() => new Date()),
  };
}

/** AC4 — before anything is parsed, read or written. */
function assertOwner(ctx: Ctx): void {
  if (!ctx.roles.includes("owner")) {
    throw new AppError("FORBIDDEN", "Only the workspace owner can manage the team");
  }
}

export const isPending = (invite: InviteDoc, now: Date): boolean =>
  invite.acceptedAt === null && invite.revokedAt === null && invite.expiresAt > now;

/** AC3 — members plus the invites still holding a seat. */
export const seatsUsed = (memberCount: number, invites: InviteDoc[], now: Date): number =>
  memberCount + invites.filter((invite) => isPending(invite, now)).length;

const toInviteView = (invite: WithId<InviteDoc>): InviteView => ({
  id: invite._id.toHexString(),
  role: invite.role,
  email: invite.email,
  expiresAt: invite.expiresAt.toISOString(),
});

/** The database narrows; `isPending` decides, so expiry is judged in one place. */
async function pendingInvites(ctx: Ctx, deps: TeamDeps, now: Date) {
  const rows = await deps.invites.find(ctx, {
    acceptedAt: null,
    revokedAt: null,
    expiresAt: { $gt: now },
  });
  return rows.filter((row) => isPending(row, now));
}

export async function createInvite(
  ctx: Ctx,
  input: unknown,
  overrides: Partial<TeamDeps> = {},
): Promise<{ invite: InviteView; url: string }> {
  assertOwner(ctx);
  const body = parse(createInviteSchema, input, "body");
  const deps = resolveDeps(overrides);
  const now = deps.now();

  const [members, pending, entitlements] = await Promise.all([
    deps.members.listMembers(ctx.tenantId),
    pendingInvites(ctx, deps, now),
    deps.entitlements(ctx),
  ]);
  const limit = limitFor(entitlements, "seats");
  const used = seatsUsed(members.length, pending, now);
  if (limit !== null && used >= limit) {
    throw new AppError(
      "QUOTA_EXCEEDED",
      "Every seat on your plan is taken. Remove someone or upgrade to invite more people.",
      { meter: "seats", limit, used, reason: "quota_exceeded" },
    );
  }

  const token = randomBytes(32).toString("base64url");
  const row = await deps.invites.insertOne(ctx, {
    role: body.role,
    email: body.email ?? null,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    createdBy: new ObjectId(ctx.userId),
    expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
    acceptedAt: null,
    revokedAt: null,
  });
  // No email and no token in the log line (Constraints: no PII in logs).
  createLogger({ requestId: ctx.requestId }).info("team.invite_created", {
    inviteId: row._id.toHexString(),
    tenantId: ctx.tenantId,
    userId: ctx.userId,
  });
  return { invite: toInviteView(row), url: `${deps.appUrl()}/invite/${token}` };
}

/** AC5 — this tenant only; pending invites only; no hash, no token. */
export async function getTeam(ctx: Ctx, overrides: Partial<TeamDeps> = {}): Promise<TeamView> {
  assertOwner(ctx);
  const deps = resolveDeps(overrides);
  const now = deps.now();
  const [members, pending, entitlements] = await Promise.all([
    deps.members.listMembers(ctx.tenantId),
    pendingInvites(ctx, deps, now),
    deps.entitlements(ctx),
  ]);
  return {
    members: members.map((m) => ({ ...m, isYou: m.userId === ctx.userId })),
    invites: pending.map(toInviteView),
    seats: {
      used: seatsUsed(members.length, pending, now),
      limit: limitFor(entitlements, "seats"),
    },
  };
}

/** AC6 — another tenant's id is invisible to the scoped repository, so 404. */
export async function revokeInvite(
  ctx: Ctx,
  inviteId: string,
  overrides: Partial<TeamDeps> = {},
): Promise<void> {
  assertOwner(ctx);
  const id = parse(objectIdHex, inviteId, "params");
  const deps = resolveDeps(overrides);
  const revoked = await deps.invites.updateOne(
    ctx,
    { _id: new ObjectId(id), acceptedAt: null, revokedAt: null },
    { $set: { revokedAt: deps.now() } },
  );
  if (!revoked) throw new AppError("NOT_FOUND", "Invite not found");
  createLogger({ requestId: ctx.requestId }).info("team.invite_revoked", {
    inviteId: id,
    tenantId: ctx.tenantId,
    userId: ctx.userId,
  });
}

/** AC7 — drops this tenant's membership only; the owner cannot remove themselves. */
export async function removeMember(
  ctx: Ctx,
  userId: string,
  overrides: Partial<TeamDeps> = {},
): Promise<void> {
  assertOwner(ctx);
  const id = parse(objectIdHex, userId, "params").toLowerCase();
  if (id === ctx.userId.toLowerCase()) {
    throw new AppError(
      "VALIDATION_FAILED",
      "You can't remove yourself from your own workspace",
    );
  }
  const deps = resolveDeps(overrides);
  const target = (await deps.members.listMembers(ctx.tenantId)).find((m) => m.userId === id);
  if (!target) throw new AppError("NOT_FOUND", "Member not found");
  if (target.roles.includes("owner")) {
    throw new AppError("VALIDATION_FAILED", "The workspace owner can't be removed");
  }
  if (!(await deps.accounts.removeMembership(id, ctx.tenantId))) {
    throw new AppError("NOT_FOUND", "Member not found");
  }
  createLogger({ requestId: ctx.requestId }).info("team.member_removed", {
    removedUserId: id,
    tenantId: ctx.tenantId,
    userId: ctx.userId,
  });
}
