/**
 * The three pieces of state the token service needs, behind ports.
 * PROTECTED PATH (.github/agent-policy.yml).
 *
 * Why ports rather than direct driver calls in the service: every rule worth
 * testing here — reuse detection, family revocation, expiry, deny-list — is
 * *logic*, and logic that can only be exercised through a live Mongo is logic
 * that gets tested thinly. The Mongo and Redis implementations below are the
 * thin part, and the integration test drives them for real.
 *
 * On tenant scoping: `refresh_tokens` cannot go through the ctx-injecting
 * repository layer (src/server/repositories/base.ts), because at the moment of
 * a refresh there is no authenticated ctx — establishing one is the point of the
 * call. Instead every query here takes `tenantId` as a required argument and
 * puts it in the filter, and it comes from the token's own routing prefix (see
 * refresh-tokens.ts). There is no code path below that queries this collection
 * without a tenant.
 */
import { ObjectId } from "mongodb";
import { getDb } from "@/server/db/mongo";
import { getRedis } from "@/server/db/redis";
import { ROLES, type Role } from "@/server/context";
import { TIERS, type Tier } from "@/server/tiers";

export type RefreshRecord = {
  tenantId: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
};

export type NewRefreshRecord = RefreshRecord & { tokenHash: string };

export type RefreshStore = {
  find(tenantId: string, tokenHash: string): Promise<RefreshRecord | null>;
  /** Atomically mark unused → used. Null means someone else got there first. */
  claim(tenantId: string, tokenHash: string, now: Date): Promise<RefreshRecord | null>;
  insert(record: NewRefreshRecord): Promise<void>;
  revokeFamily(tenantId: string, familyId: string, now: Date): Promise<void>;
};

export type Identity = { roles: readonly Role[]; tier: Tier };

export type IdentityStore = {
  /** Null when the user is gone, the tenant is gone, or the membership ended. */
  resolve(tenantId: string, userId: string): Promise<Identity | null>;
};

export type DenyList = {
  deny(jti: string, ttlSeconds: number): Promise<void>;
  isDenied(jti: string): Promise<boolean>;
};

const oid = (hex: string) => new ObjectId(hex);

const REFRESH_COLLECTION = "refresh_tokens";

type RefreshDoc = {
  tenantId: ObjectId;
  userId: ObjectId;
  familyId: ObjectId;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
};

const toRecord = (doc: RefreshDoc): RefreshRecord => ({
  tenantId: doc.tenantId.toHexString(),
  userId: doc.userId.toHexString(),
  familyId: doc.familyId.toHexString(),
  expiresAt: doc.expiresAt,
  usedAt: doc.usedAt ?? null,
  revokedAt: doc.revokedAt ?? null,
});

export function mongoRefreshStore(): RefreshStore {
  const collection = async () => (await getDb()).collection<RefreshDoc>(REFRESH_COLLECTION);

  return {
    async find(tenantId, tokenHash) {
      const doc = await (await collection()).findOne({ tenantId: oid(tenantId), tokenHash });
      return doc ? toRecord(doc) : null;
    },

    async claim(tenantId, tokenHash, now) {
      // The filter *is* the concurrency control: only the first caller matches
      // `usedAt: null`, so two simultaneous presentations of one token cannot
      // both succeed. The loser is treated as reuse, which is what it is.
      const doc = await (
        await collection()
      ).findOneAndUpdate(
        { tenantId: oid(tenantId), tokenHash, usedAt: null, revokedAt: null },
        { $set: { usedAt: now } },
        { returnDocument: "before" },
      );
      return doc ? toRecord(doc) : null;
    },

    async insert(record) {
      await (
        await collection()
      ).insertOne({
        tenantId: oid(record.tenantId),
        userId: oid(record.userId),
        familyId: oid(record.familyId),
        tokenHash: record.tokenHash,
        expiresAt: record.expiresAt,
        usedAt: null,
        revokedAt: null,
      });
    },

    async revokeFamily(tenantId, familyId, now) {
      await (
        await collection()
      ).updateMany(
        { tenantId: oid(tenantId), familyId: oid(familyId), revokedAt: null },
        { $set: { revokedAt: now } },
      );
    },
  };
}

/**
 * Roles and tier are read live at refresh rather than carried on the refresh
 * token, so a revoked membership or a downgraded tenant takes effect within one
 * access-token lifetime instead of thirty days.
 */
export function mongoIdentityStore(): IdentityStore {
  return {
    async resolve(tenantId, userId) {
      const db = await getDb();
      const tenant = await db
        .collection<{ tier: string }>("tenants")
        .findOne({ _id: oid(tenantId) });
      if (!tenant || !(TIERS as readonly string[]).includes(tenant.tier)) return null;

      const membership = await db
        .collection<{ memberships?: { tenantId: ObjectId; roles: string[] }[] }>("users")
        .findOne(
          { _id: oid(userId), "memberships.tenantId": oid(tenantId) },
          { projection: { memberships: 1 } },
        );
      const roles = (membership?.memberships ?? [])
        .find((m) => m.tenantId.equals(oid(tenantId)))
        ?.roles.filter((role): role is Role => (ROLES as readonly string[]).includes(role));
      if (!roles?.length) return null;

      return { roles, tier: tenant.tier as Tier };
    },
  };
}

const DENY_PREFIX = "auth:jti-denied:";

export function redisDenyList(): DenyList {
  return {
    async deny(jti, ttlSeconds) {
      // The entry only has to outlive the token it revokes; after that the
      // signature's own expiry does the work and the key is dead weight.
      await getRedis().set(`${DENY_PREFIX}${jti}`, "1", "EX", Math.max(1, ttlSeconds));
    },
    async isDenied(jti) {
      return (await getRedis().exists(`${DENY_PREFIX}${jti}`)) === 1;
    },
  };
}
