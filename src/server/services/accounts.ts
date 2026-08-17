/**
 * Accounts, tenant bootstrap and the login flow (GRAFT-03.2, docs/BACKEND.md
 * §3.2, docs/Graft.md §3 onboarding steps 2–3).
 *
 * Every decision lives here; the five routes above it parse, delegate and set
 * cookies (docs/BACKEND.md §1). Persistence is a port so the rules that matter —
 * what a duplicate does, what an unverified login does, whether a failed signup
 * leaves a tenant behind — are testable as logic.
 *
 * Two properties are structural rather than incidental, and both are easy to
 * lose in a later edit:
 *
 *   - **No account enumeration** (AC8). The unknown-email and wrong-password
 *     paths run the same code with the same cost and end in the same
 *     `unauthorized()`. The verified-email check happens *after* the password
 *     check, deliberately: otherwise "unverified" would tell an attacker the
 *     address is registered without needing the password at all.
 *   - **Signup is all-or-nothing** (AC2, AC5). Mongo runs standalone here, so
 *     there is no transaction to lean on. Instead the tenant is created first
 *     and deleted again if the user insert loses a race, so a rejected signup
 *     can never leave an orphaned tenant holding a slug nobody owns.
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  DuplicateKeyError,
  mongoAccountStore,
  type AccountStore,
  type Membership,
  type UserRecord,
} from "@/server/auth/accounts-store";
import { hashPassword, passwordSchema, verifyPassword } from "@/server/auth/passwords";
import type { Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import { parse } from "@/server/http/validate";
import { createLogger } from "@/server/log";
import { TIER_LIMITS, type Tier, type TierLimits } from "@/server/tiers";
import { isReservedSlug, slugify } from "./slugs";
import { issueSession, type AccessTokenInput, type Session } from "./tokens";

/** Long enough to survive a slow mail queue, short enough to be a credential. */
export const VERIFICATION_TTL_SECONDS = 24 * 60 * 60;

/** New tenants always start here (Constraints); upgrades are GRAFT-15. */
const SIGNUP_TIER: Tier = "free";

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Enter a valid email address")
  .max(254);

const objectIdHex = z.string().regex(/^[0-9a-f]{24}$/i, "Expected a 24-character id");

export const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  businessName: z.string().trim().min(2).max(120),
});

export const loginSchema = z.object({ email: emailSchema, password: z.string().max(400) });

/** Same alphabet and bounds as the refresh secret — base64url of 32 bytes. */
export const verificationTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{20,128}$/, "Invalid token");

export const verifyEmailSchema = z.object({ token: verificationTokenSchema });

export const switchTenantSchema = z.object({ tenantId: objectIdHex });

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

/** What the mailer will send once transactional email exists (out of scope). */
export type VerificationIssued = {
  userId: string;
  email: string;
  token: string;
  expiresAt: Date;
};

export type AccountDeps = {
  accounts: AccountStore;
  now: () => Date;
  issue: (input: AccessTokenInput) => Promise<Session>;
  emitVerificationToken: (event: VerificationIssued) => void;
};

/**
 * The mailer seam. Until GRAFT sends real email, the token goes to the log so a
 * developer can complete the flow by hand. The address is included because this
 * line only ever exists in dev and QA — see the guard.
 */
const logVerificationToken = (event: VerificationIssued): void => {
  const log = createLogger({ requestId: "auth.verification" });
  if (process.env.APP_ENV === "production") {
    // AC4 / §1.5: never write a live credential to a production log. The seam
    // stays, the value does not — a real mailer replaces this branch.
    log.info("auth.verification.issued", { userId: event.userId });
    return;
  }
  log.info("auth.verification.issued", {
    userId: event.userId,
    email: event.email,
    token: event.token,
    expiresAt: event.expiresAt.toISOString(),
  });
};

function resolve(overrides: Partial<AccountDeps> = {}): AccountDeps {
  return {
    accounts: overrides.accounts ?? mongoAccountStore(),
    now: overrides.now ?? (() => new Date()),
    issue: overrides.issue ?? ((input) => issueSession(input)),
    emitVerificationToken: overrides.emitVerificationToken ?? logVerificationToken,
  };
}

/** One message for every credential failure — see AC8. */
const unauthorized = (): never => {
  throw new AppError("UNAUTHORIZED", "Invalid email or password");
};

const invalid = (field: string, message: string): never => {
  throw new AppError("VALIDATION_FAILED", "Invalid request body", {
    source: "body",
    fields: { [field]: message },
  });
};

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** A copy, never the shared constant — Enterprise overrides edit the tenant. */
const limitsFor = (tier: Tier): TierLimits => ({ ...TIER_LIMITS[tier] });

async function createVerification(
  user: { id: string; email: string },
  deps: AccountDeps,
): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(deps.now().getTime() + VERIFICATION_TTL_SECONDS * 1000);
  // Only the hash is stored, exactly as for refresh tokens: a dump of the
  // collection yields nothing spendable.
  await deps.accounts.insertVerificationToken({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  deps.emitVerificationToken({ userId: user.id, email: user.email, token, expiresAt });
}

/**
 * AC1, AC2, AC4, AC5. Creates the account and the tenant it owns, materialising
 * the tier limits onto the tenant so entitlement checks (GRAFT-05) read one
 * document rather than joining against a constant.
 */
export async function signup(
  input: SignupInput,
  overrides: Partial<AccountDeps> = {},
): Promise<{ userId: string; tenantId: string }> {
  const deps = resolve(overrides);
  // Parsed again here, not only at the route: the service is the boundary
  // that matters, and a future internal caller must meet the same contract.
  const { email, password, businessName } = parse(signupSchema, input, "body");

  const slug = slugify(businessName);
  if (!slug) invalid("businessName", "Use at least one letter or number");
  if (isReservedSlug(slug!)) invalid("businessName", "That name is reserved");

  // Both pre-checks are courtesy, not enforcement: the unique indexes below are
  // what actually decide, and the races are handled where they are lost.
  if (await deps.accounts.findUserByEmail(email)) {
    throw new AppError("CONFLICT", "An account with that email already exists");
  }
  if (await deps.accounts.findTenantBySlug(slug!)) {
    throw new AppError("CONFLICT", "That business name is already taken");
  }

  const passwordHash = await hashPassword(password);

  let tenantId: string;
  try {
    tenantId = await deps.accounts.insertTenant({
      name: businessName,
      slug: slug!,
      tier: SIGNUP_TIER,
      limits: limitsFor(SIGNUP_TIER),
    });
  } catch (error) {
    if (error instanceof DuplicateKeyError) {
      throw new AppError("CONFLICT", "That business name is already taken");
    }
    throw error;
  }

  let userId: string;
  try {
    userId = await deps.accounts.insertUser({
      email,
      name: null,
      passwordHash,
      memberships: [{ tenantId, roles: ["owner"] }],
    });
  } catch (error) {
    // The compensating half of "creates nothing" (AC2): the tenant exists only
    // because this user was about to. It must not outlive them.
    await deps.accounts.deleteTenant(tenantId);
    if (error instanceof DuplicateKeyError) {
      throw new AppError("CONFLICT", "An account with that email already exists");
    }
    throw error;
  }

  await createVerification({ id: userId, email }, deps);
  return { userId, tenantId };
}

/**
 * AC3. Single-use and expiring, both enforced by the store's atomic claim — a
 * check-then-update here would be a race on a credential.
 */
export async function verifyEmail(
  token: string,
  overrides: Partial<AccountDeps> = {},
): Promise<void> {
  const deps = resolve(overrides);
  const parsed = verificationTokenSchema.safeParse(token);
  if (!parsed.success) invalid("token", "Invalid token");

  const now = deps.now();
  const claimed = await deps.accounts.claimVerificationToken(hashToken(parsed.data!), now);
  // Unknown, expired and already-spent are one answer on purpose: which of the
  // three it was is not something a caller needs, or should be able to probe.
  if (!claimed) throw new AppError("NOT_FOUND", "That verification link is no longer valid");

  await deps.accounts.markEmailVerified(claimed.userId, now);
}

/** The tenant a login lands in: the first membership, which for a fresh account
 * is the one signup created. Multi-tenant users switch from there (AC6). */
const primaryMembership = (user: UserRecord): Membership | undefined => user.memberships[0];

/** AC3, AC8. */
export async function login(
  input: LoginInput,
  overrides: Partial<AccountDeps> = {},
): Promise<Session> {
  const deps = resolve(overrides);
  const { email, password } = parse(loginSchema, input, "body");

  const user = await deps.accounts.findUserByEmail(email);
  // Unconditional, and before any branch on `user`: verifyPassword does real
  // argon2 work even when the hash is null, so the two paths cost the same.
  const matched = await verifyPassword(user?.passwordHash ?? null, password);
  if (!user || !matched) return unauthorized();

  // Only now — a caller who does not know the password learns nothing here.
  if (!user.emailVerifiedAt) {
    throw new AppError("EMAIL_NOT_VERIFIED", "Verify your email address before signing in");
  }

  const membership = primaryMembership(user);
  if (!membership) return unauthorized();
  const tenant = await deps.accounts.findTenantById(membership.tenantId);
  if (!tenant) return unauthorized();

  return deps.issue({
    tenantId: tenant.id,
    userId: user.id,
    roles: membership.roles,
    tier: tenant.tier,
  });
}

/**
 * AC6. One token is always one tenant (docs/BACKEND.md §3.1), so switching means
 * minting a new one — the caller's existing token is untouched and keeps
 * granting exactly the tenant it named.
 */
export async function switchTenant(
  ctx: Ctx,
  tenantId: string,
  overrides: Partial<AccountDeps> = {},
): Promise<Session> {
  const deps = resolve(overrides);
  const parsed = switchTenantSchema.safeParse({ tenantId });
  if (!parsed.success) invalid("tenantId", "Expected a 24-character id");
  const target = parsed.data!.tenantId;

  const user = await deps.accounts.findUserById(ctx.userId);
  const membership = user?.memberships.find((m) => m.tenantId === target);
  const tenant = membership ? await deps.accounts.findTenantById(target) : null;
  // A tenant that does not exist and a tenant you are not in are one answer:
  // a 404 here would confirm which tenant ids are real.
  if (!user || !membership || !tenant) {
    throw new AppError("FORBIDDEN", "You are not a member of that workspace");
  }

  return deps.issue({
    tenantId: tenant.id,
    userId: user.id,
    roles: membership.roles,
    tier: tenant.tier,
  });
}

export type MeView = {
  user: { id: string; email: string; name: string | null; emailVerifiedAt: Date | null };
  memberships: { tenantId: string; slug: string; name: string; roles: Membership["roles"] }[];
  tenant: {
    id: string;
    name: string;
    slug: string;
    tier: Tier;
    limits: TierLimits;
    /** GRAFT-11.4 AC3 — the shell's only source for the tenant's brand colour. */
    branding: { logoUrl: string | null; primaryColor: string | null } | null;
  };
};

/**
 * AC7 — the one object the UI reads for identity and entitlement. The password
 * hash is not omitted by convention here; it is never placed in the view at all.
 */
export async function getMe(ctx: Ctx, overrides: Partial<AccountDeps> = {}): Promise<MeView> {
  const deps = resolve(overrides);
  const user = await deps.accounts.findUserById(ctx.userId);
  if (!user) return unauthorized();

  // The token was verified, but a membership can be revoked inside its 15-minute
  // life — so the active tenant is re-checked against the database, not the token.
  const active = user.memberships.find((m) => m.tenantId === ctx.tenantId);
  if (!active) throw new AppError("FORBIDDEN", "You are not a member of that workspace");

  const tenants = await Promise.all(
    user.memberships.map((m) => deps.accounts.findTenantById(m.tenantId)),
  );
  const memberships = user.memberships.flatMap((m, index) => {
    const tenant = tenants[index];
    // A membership pointing at a deleted tenant is stale, not an error.
    return tenant
      ? [{ tenantId: m.tenantId, slug: tenant.slug, name: tenant.name, roles: m.roles }]
      : [];
  });

  const tenant = tenants[user.memberships.indexOf(active)];
  if (!tenant) throw new AppError("FORBIDDEN", "You are not a member of that workspace");

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerifiedAt: user.emailVerifiedAt,
    },
    memberships,
    tenant: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      tier: tenant.tier,
      limits: tenant.limits,
      branding: tenant.branding,
    },
  };
}
