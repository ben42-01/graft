/**
 * A team (GRAFT-33.1, 33.2): the owner's invite links, member list and removals,
 * and the other end of a link — previewing it, accepting it, or signing up
 * through it.
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
import { createContext, ROLES, type Ctx, type Role } from "@/server/context";
import { getDb } from "@/server/db/mongo";
import { AppError } from "@/server/http/envelope";
import { parse } from "@/server/http/validate";
import { createLogger } from "@/server/log";
import { createRepository, type Repository } from "@/server/repositories/base";
import {
  mongoAccountStore,
  type AccountStore,
  type Membership,
  type TenantRecord,
} from "@/server/auth/accounts-store";
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
  accounts: Pick<
    AccountStore,
    "removeMembership" | "addMembership" | "findUserById" | "findTenantById"
  >;
  /** GRAFT-33.2 — lookups by token hash, before there is a tenant to scope by. */
  inviteStore: InviteStore;
  entitlements: (ctx: Ctx) => Promise<Entitlements>;
  appUrl: () => string;
  now: () => Date;
};

export type InviteRow = WithId<InviteDoc>;

/**
 * The one place invites are read without a tenant. The invitee has no session
 * in the tenant yet, so the lookup is by `tokenHash` (unique index) and the
 * tenant comes *out* of the row — never from the request. Everything else
 * about invites still goes through the tenant-scoped repository.
 */
export type InviteStore = {
  findByTokenHash(tokenHash: string): Promise<InviteRow | null>;
  pendingForTenant(tenantId: ObjectId, now: Date): Promise<InviteRow[]>;
  /** Atomically pending → accepted. False means someone else got there first. */
  claim(id: ObjectId, now: Date): Promise<boolean>;
  /** The compensating undo for `claim`. */
  release(id: ObjectId): Promise<void>;
};

export function mongoInviteStore(): InviteStore {
  const invites = async () => (await getDb()).collection<InviteDoc>("invites");
  return {
    async findByTokenHash(tokenHash) {
      return (await invites()).findOne({ tokenHash });
    },
    async pendingForTenant(tenantId, now) {
      return (await invites())
        .find({ tenantId, acceptedAt: null, revokedAt: null, expiresAt: { $gt: now } })
        .toArray();
    },
    async claim(id, now) {
      const result = await (
        await invites()
      ).updateOne(
        { _id: id, acceptedAt: null, revokedAt: null, expiresAt: { $gt: now } },
        { $set: { acceptedAt: now } },
      );
      return result.modifiedCount > 0;
    },
    async release(id) {
      await (await invites()).updateOne({ _id: id }, { $set: { acceptedAt: null } });
    },
  };
}

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
    inviteStore: overrides.inviteStore ?? mongoInviteStore(),
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

// ---------------------------------------------------------------------------
// The invitee's side (GRAFT-33.2)
// ---------------------------------------------------------------------------

/** Body of `POST /team/invites/accept`. Anything else in it is ignored. */
export const acceptInviteSchema = z.object({ token: z.string().max(256) });

const hashInviteToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** AC2 — one answer for unknown, expired, revoked and already used. */
const inviteNotFound = () => new AppError("NOT_FOUND", "Invite not found");

/** Unknown, expired, revoked and spent all read as "not there" (AC2, AC7). */
async function findPendingInvite(
  token: string,
  deps: TeamDeps,
  now: Date,
): Promise<{ invite: InviteRow; tenant: TenantRecord }> {
  const invite = await deps.inviteStore.findByTokenHash(hashInviteToken(token));
  if (!invite || !isPending(invite, now)) throw inviteNotFound();
  const tenant = await deps.accounts.findTenantById(invite.tenantId.toHexString());
  if (!tenant) throw inviteNotFound();
  return { invite, tenant };
}

/** AC7 — what the landing page needs to say "Join Harbour Boats as a Member". */
export async function previewInvite(
  token: string,
  overrides: Partial<TeamDeps> = {},
): Promise<{ workspaceName: string; role: InviteRole; email?: string }> {
  const deps = resolveDeps(overrides);
  const { invite, tenant } = await findPendingInvite(token, deps, deps.now());
  return {
    workspaceName: tenant.name,
    role: invite.role,
    ...(invite.email ? { email: invite.email } : {}),
  };
}

export type ClaimedInvite = {
  tenantId: string;
  tenantSlug: string;
  role: InviteRole;
  /** Undo the claim when what should follow it fails (AC8). */
  release: () => Promise<void>;
};

/**
 * AC1–AC5, AC8 — the shared front half of accepting and of signing up through
 * a link. Order matters and is the contract's: not-pending 404, then bound
 * email 403, then already-a-member 409, then the seat re-check 402, and only
 * then the claim. Nothing is written until every refusal has been passed, and
 * the claim itself is atomic, so two people racing one link cannot both win.
 *
 * The claim comes *before* the membership is added: a crash in between leaves
 * an accepted invite with no membership — an unusable token — never a usable
 * token behind a granted seat. The caller undoes the claim if its own write
 * fails.
 */
export async function claimInvite(
  token: string,
  subject: { email: string; userId?: string; memberships: Membership[] },
  overrides: Partial<TeamDeps> = {},
): Promise<ClaimedInvite> {
  const deps = resolveDeps(overrides);
  const now = deps.now();
  const { invite, tenant } = await findPendingInvite(token, deps, now);

  if (invite.email && invite.email.toLowerCase() !== subject.email.trim().toLowerCase()) {
    throw new AppError("FORBIDDEN", "This invite was sent to a different email address");
  }
  if (subject.memberships.some((m) => m.tenantId === tenant.id)) {
    throw new AppError("CONFLICT", "You are already a member of this workspace");
  }

  // The invite being claimed holds a seat itself, so it is not counted twice.
  const ctx = createContext({
    requestId: "team.invite_accept",
    tenantId: tenant.id,
    userId: subject.userId ?? invite.createdBy.toHexString(),
    roles: [invite.role],
    tier: tenant.tier,
  });
  const [members, pending, entitlements] = await Promise.all([
    deps.members.listMembers(tenant.id),
    deps.inviteStore.pendingForTenant(invite.tenantId, now),
    deps.entitlements(ctx),
  ]);
  const limit = limitFor(entitlements, "seats");
  const used = members.length + pending.filter((p) => !p._id.equals(invite._id)).length;
  if (limit !== null && used >= limit) {
    throw new AppError(
      "QUOTA_EXCEEDED",
      "This workspace has no free seat left. Ask its owner to make room.",
      { meter: "seats", limit, used, reason: "quota_exceeded" },
    );
  }

  if (!(await deps.inviteStore.claim(invite._id, now))) throw inviteNotFound();
  return {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    role: invite.role,
    release: () => deps.inviteStore.release(invite._id),
  };
}

/** AC1–AC5, AC8 — a signed-in user takes the seat the link offers. */
export async function acceptInvite(
  ctx: Ctx,
  input: unknown,
  overrides: Partial<TeamDeps> = {},
): Promise<{ tenantId: string; tenantSlug: string; role: InviteRole }> {
  const { token } = parse(acceptInviteSchema, input, "body");
  const deps = resolveDeps(overrides);
  const user = await deps.accounts.findUserById(ctx.userId);
  if (!user) throw new AppError("UNAUTHORIZED", "Invalid request context");

  const claimed = await claimInvite(
    token,
    { email: user.email, userId: user.id, memberships: user.memberships },
    overrides,
  );
  try {
    // The invite's own tenant and role — nothing from the request body.
    if (!(await deps.accounts.addMembership(user.id, claimed.tenantId, [claimed.role]))) {
      throw new AppError("CONFLICT", "You are already a member of this workspace");
    }
  } catch (error) {
    await claimed.release();
    throw error;
  }
  createLogger({ requestId: ctx.requestId }).info("team.invite_accepted", {
    tenantId: claimed.tenantId,
    userId: user.id,
  });
  return { tenantId: claimed.tenantId, tenantSlug: claimed.tenantSlug, role: claimed.role };
}
