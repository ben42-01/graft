/**
 * Persistence for accounts, tenants and email verification, behind ports.
 * PROTECTED PATH (.github/agent-policy.yml: src/server/auth/**).
 *
 * Why this cannot go through the ctx-injecting repository layer
 * (src/server/repositories/base.ts): every operation here happens *before* there
 * is an authenticated tenant. Signup creates the tenant, login discovers it, and
 * verification runs on a token with no session at all — there is no ctx to scope
 * by, because establishing one is the point of the call. Same argument as
 * ./stores.ts, and the same discipline applies: `users` and `tenants` are
 * genuinely global collections keyed by `_id`, so there is no tenant filter to
 * forget. Nothing below reads a tenant-scoped business collection.
 *
 * Uniqueness is the database's job, not this file's. `users.email` and
 * `tenants.slug` both carry unique indexes (scripts/create-indexes.ts), and the
 * driver's E11000 is translated into a `DuplicateKeyError` so the service can
 * turn a lost race into the same 409 as a lost pre-check.
 */
import { MongoServerError, ObjectId, type Db } from "mongodb";
import { getDb } from "@/server/db/mongo";
import { ROLES, type Role } from "@/server/context";
import { TIERS, type Tier, type TierLimits } from "@/server/tiers";

export type Membership = { tenantId: string; roles: Role[] };

export type UserRecord = {
  id: string;
  email: string;
  name: string | null;
  /** Null only for accounts created before passwords existed, or OAuth-only. */
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
  memberships: Membership[];
};

/**
 * Written by tenant creation (and seed data) since before this type existed;
 * surfaced here so GRAFT-11.4's shell can read a branding colour from `/me`
 * without inventing a new write path (docs/Graft.md §4.3 — branding is
 * Free-tier-badged, Premium removes it).
 */
export type TenantBranding = { logoUrl: string | null; primaryColor: string | null };

export type TenantRecord = {
  id: string;
  name: string;
  slug: string;
  tier: Tier;
  limits: TierLimits;
  branding: TenantBranding | null;
};

export type NewUser = {
  email: string;
  name: string | null;
  passwordHash: string;
  memberships: Membership[];
};

export type NewTenant = {
  name: string;
  slug: string;
  tier: Tier;
  limits: TierLimits;
  branding?: TenantBranding | null;
};

/** Which unique index rejected the write — the service maps it to a message. */
export type DuplicateField = "email" | "slug";

export class DuplicateKeyError extends Error {
  constructor(readonly field: DuplicateField) {
    super(`A record with that ${field} already exists`);
    this.name = "DuplicateKeyError";
  }
}

export type VerificationToken = { userId: string; tokenHash: string; expiresAt: Date };

export type AccountStore = {
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  insertUser(user: NewUser): Promise<string>;
  deleteUser(id: string): Promise<void>;
  insertTenant(tenant: NewTenant): Promise<string>;
  deleteTenant(id: string): Promise<void>;
  findTenantById(id: string): Promise<TenantRecord | null>;
  findTenantBySlug(slug: string): Promise<TenantRecord | null>;
  markEmailVerified(userId: string, at: Date): Promise<void>;
  insertVerificationToken(token: VerificationToken): Promise<void>;
  /** Atomically unused → used. Null means unknown, expired, or already spent. */
  claimVerificationToken(tokenHash: string, now: Date): Promise<{ userId: string } | null>;
};

export const VERIFICATION_COLLECTION = "email_verification_tokens";

const oid = (hex: string) => new ObjectId(hex);

/**
 * `_id` is invalid hex on any path a client can reach only if validation was
 * skipped upstream; returning null keeps that a 404/403 rather than a 500.
 */
const safeOid = (hex: string): ObjectId | null =>
  ObjectId.isValid(hex) ? new ObjectId(hex) : null;

type UserDoc = {
  _id: ObjectId;
  email: string;
  name?: string | null;
  passwordHash?: string | null;
  emailVerifiedAt?: Date | null;
  memberships?: { tenantId: ObjectId; roles: string[] }[];
};

type TenantDoc = {
  _id: ObjectId;
  name: string;
  slug: string;
  tier: string;
  limits: TierLimits;
  branding?: TenantBranding | null;
};

type VerificationDoc = {
  _id: ObjectId;
  userId: ObjectId;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
};

/** Unknown roles are dropped rather than trusted — the enum is the contract. */
const toRoles = (roles: readonly string[]): Role[] =>
  roles.filter((role): role is Role => (ROLES as readonly string[]).includes(role));

const toUser = (doc: UserDoc): UserRecord => ({
  id: doc._id.toHexString(),
  email: doc.email,
  name: doc.name ?? null,
  passwordHash: doc.passwordHash ?? null,
  emailVerifiedAt: doc.emailVerifiedAt ?? null,
  memberships: (doc.memberships ?? []).map((m) => ({
    tenantId: m.tenantId.toHexString(),
    roles: toRoles(m.roles),
  })),
});

/** A tenant on a tier we do not recognise is not usable — treat it as missing. */
const toTenant = (doc: TenantDoc): TenantRecord | null =>
  (TIERS as readonly string[]).includes(doc.tier)
    ? {
        id: doc._id.toHexString(),
        name: doc.name,
        slug: doc.slug,
        tier: doc.tier as Tier,
        limits: doc.limits,
        branding: doc.branding ?? null,
      }
    : null;

const isDuplicateKey = (error: unknown): boolean =>
  error instanceof MongoServerError && error.code === 11000;

export function mongoAccountStore(): AccountStore {
  const collections = async (db?: Db) => {
    const database = db ?? (await getDb());
    return {
      users: database.collection<UserDoc>("users"),
      tenants: database.collection<TenantDoc>("tenants"),
      verifications: database.collection<VerificationDoc>(VERIFICATION_COLLECTION),
    };
  };

  return {
    async findUserByEmail(email) {
      const { users } = await collections();
      const doc = await users.findOne({ email });
      return doc ? toUser(doc) : null;
    },

    async findUserById(id) {
      const _id = safeOid(id);
      if (!_id) return null;
      const { users } = await collections();
      const doc = await users.findOne({ _id });
      return doc ? toUser(doc) : null;
    },

    async insertUser(user) {
      const { users } = await collections();
      const now = new Date();
      try {
        const { insertedId } = await users.insertOne({
          _id: new ObjectId(),
          email: user.email,
          name: user.name,
          passwordHash: user.passwordHash,
          emailVerifiedAt: null,
          memberships: user.memberships.map((m) => ({
            tenantId: oid(m.tenantId),
            roles: [...m.roles],
          })),
          createdAt: now,
          updatedAt: now,
        } as UserDoc);
        return insertedId.toHexString();
      } catch (error) {
        // Only the email index is unique on this collection.
        if (isDuplicateKey(error)) throw new DuplicateKeyError("email");
        throw error;
      }
    },

    async deleteUser(id) {
      const _id = safeOid(id);
      if (!_id) return;
      const { users } = await collections();
      await users.deleteOne({ _id });
    },

    async insertTenant(tenant) {
      const { tenants } = await collections();
      const now = new Date();
      try {
        const { insertedId } = await tenants.insertOne({
          _id: new ObjectId(),
          name: tenant.name,
          slug: tenant.slug,
          tier: tenant.tier,
          limits: tenant.limits,
          branding: tenant.branding ?? null,
          settings: { currency: "EUR", timezone: "UTC", locale: "en" },
          createdAt: now,
          updatedAt: now,
        } as TenantDoc);
        return insertedId.toHexString();
      } catch (error) {
        if (isDuplicateKey(error)) throw new DuplicateKeyError("slug");
        throw error;
      }
    },

    async deleteTenant(id) {
      const _id = safeOid(id);
      if (!_id) return;
      const { tenants } = await collections();
      await tenants.deleteOne({ _id });
    },

    async findTenantById(id) {
      const _id = safeOid(id);
      if (!_id) return null;
      const { tenants } = await collections();
      const doc = await tenants.findOne({ _id });
      return doc ? toTenant(doc) : null;
    },

    async findTenantBySlug(slug) {
      const { tenants } = await collections();
      const doc = await tenants.findOne({ slug });
      return doc ? toTenant(doc) : null;
    },

    async markEmailVerified(userId, at) {
      const _id = safeOid(userId);
      if (!_id) return;
      const { users } = await collections();
      await users.updateOne({ _id }, { $set: { emailVerifiedAt: at, updatedAt: at } });
    },

    async insertVerificationToken({ userId, tokenHash, expiresAt }) {
      const { verifications } = await collections();
      await verifications.insertOne({
        _id: new ObjectId(),
        userId: oid(userId),
        tokenHash,
        expiresAt,
        usedAt: null,
      });
    },

    async claimVerificationToken(tokenHash, now) {
      const { verifications } = await collections();
      // The filter is the concurrency control, exactly as in the refresh store:
      // only the first presentation matches `usedAt: null`, so a token cannot be
      // spent twice even by two simultaneous requests.
      const doc = await verifications.findOneAndUpdate(
        { tokenHash, usedAt: null, expiresAt: { $gt: now } },
        { $set: { usedAt: now } },
        { returnDocument: "before" },
      );
      return doc ? { userId: doc.userId.toHexString() } : null;
    },
  };
}
