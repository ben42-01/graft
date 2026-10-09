/**
 * Mongo half of the CLI device sign-in (src/server/services/device-auth.ts).
 *
 * Thin on purpose: every rule lives in the service, which is unit tested
 * against an in-memory double; this file only translates. `device_authorizations`
 * is a global collection — a request belongs to no tenant until someone
 * approves it — so, like `users` and `refresh_tokens`, it is read directly
 * rather than through the ctx-scoped repository layer, and every lookup is by
 * an unguessable key (the deviceCode hash) or by a short-lived pending code.
 *
 * Indexes (scripts/create-indexes.ts): unique on `deviceCodeHash`; unique on
 * `userCode` among pending rows only, so a code can be reused once its request
 * is decided; TTL on `expiresAt` to sweep old rows a day later.
 */
import { MongoServerError, ObjectId } from "mongodb";
import { getDb } from "@/server/db/mongo";
import type {
  DeviceAuthorization,
  DeviceAuthStore,
  NewDeviceAuthorization,
} from "@/server/services/device-auth";

export const DEVICE_AUTH_COLLECTION = "device_authorizations";

/** A live request already holds the generated userCode — try another. */
export class DuplicateUserCodeError extends Error {
  constructor() {
    super("user code already in use");
    this.name = "DuplicateUserCodeError";
  }
}

type Doc = Omit<DeviceAuthorization, "id" | "userId" | "tenantId"> & {
  _id: ObjectId;
  userId: ObjectId | null;
  tenantId: ObjectId | null;
};

const toRecord = (doc: Doc): DeviceAuthorization => ({
  id: doc._id.toHexString(),
  deviceCodeHash: doc.deviceCodeHash,
  userCode: doc.userCode,
  client: doc.client,
  status: doc.status,
  userId: doc.userId?.toHexString() ?? null,
  tenantId: doc.tenantId?.toHexString() ?? null,
  createdAt: doc.createdAt,
  expiresAt: doc.expiresAt,
  lastPolledAt: doc.lastPolledAt,
  decidedAt: doc.decidedAt,
});

async function collection() {
  return (await getDb()).collection<Doc>(DEVICE_AUTH_COLLECTION);
}

export function mongoDeviceAuthStore(): DeviceAuthStore {
  return {
    async insert(record: NewDeviceAuthorization) {
      try {
        await (
          await collection()
        ).insertOne({
          ...record,
          _id: new ObjectId(),
          userId: null,
          tenantId: null,
        });
      } catch (error) {
        if (error instanceof MongoServerError && error.code === 11000) {
          throw new DuplicateUserCodeError();
        }
        throw error;
      }
    },

    async findByDeviceCodeHash(hash) {
      const doc = await (await collection()).findOne({ deviceCodeHash: hash });
      return doc ? toRecord(doc) : null;
    },

    async findPendingByUserCode(userCode, now) {
      const doc = await (
        await collection()
      ).findOne({ userCode, status: "pending", expiresAt: { $gt: now } });
      return doc ? toRecord(doc) : null;
    },

    async decide(id, { status, userId, tenantId, at }) {
      const result = await (
        await collection()
      ).updateOne(
        { _id: new ObjectId(id), status: "pending", expiresAt: { $gt: at } },
        {
          $set: {
            status,
            userId: new ObjectId(userId),
            tenantId: new ObjectId(tenantId),
            decidedAt: at,
          },
        },
      );
      return result.modifiedCount === 1;
    },

    async consume(id, at) {
      const result = await (
        await collection()
      ).updateOne(
        { _id: new ObjectId(id), status: "approved" },
        { $set: { status: "consumed", lastPolledAt: at } },
      );
      return result.modifiedCount === 1;
    },

    async touchPoll(id, at) {
      await (
        await collection()
      ).updateOne({ _id: new ObjectId(id) }, { $set: { lastPolledAt: at } });
    },
  };
}
