/**
 * Browser sign-in for the Graft CLI — an OAuth 2.0 device authorization grant
 * (RFC 8628), shaped to this API's envelope.
 *
 *   1. The CLI calls `start`: it gets a secret `deviceCode` it keeps, and a
 *      short `userCode` (BCDF-GHJK) it shows the person with the URL.
 *   2. The person opens `/device` in a browser where they are signed in, types
 *      the code, sees which machine is asking, and approves or denies. The
 *      approval binds the request to *their* user and *their current* tenant.
 *   3. The CLI polls `poll` with the deviceCode until it is approved, then gets
 *      an ordinary session — the same access token + refresh family a browser
 *      login gets, minted by `issueSession`, refreshed through the same
 *      `/auth/refresh`. Nothing downstream can tell a CLI session apart, which
 *      is the point: no second kind of credential to secure.
 *
 * Why device flow rather than a localhost redirect: it works when the CLI runs
 * over ssh on a server with no browser, and the CLI never listens on a port.
 *
 * Security properties, each one tested in device-auth.test.ts:
 *  - The deviceCode is 32 random bytes and is stored only as a SHA-256 hash,
 *    like refresh and verification tokens. A database read does not yield a
 *    usable code.
 *  - The person types the userCode; it is never carried in a link. A link that
 *    pre-fills the code is the standard device-code phishing vector ("click
 *    here and press Approve"), and typing the code from your own terminal is
 *    what proves the terminal is yours.
 *  - Single use. Approved → consumed is a compare-and-set, so two concurrent
 *    polls cannot both mint a session.
 *  - Ten minutes from start to approval, then the request is dead.
 *  - Roles and tier are re-read at issue time, never copied from the approving
 *    session (same rule as rotateSession).
 *  - The client details shown on the approval page are what the CLI *claims*.
 *    They are sanitised for display and labelled as such; the userCode, not the
 *    hostname, is what the person is asked to check.
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { env } from "@/env";
import type { Ctx } from "@/server/context";
import { newRequestId } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import { parse } from "@/server/http/validate";
import { mongoIdentityStore, type IdentityStore } from "@/server/auth/stores";
import { issueSession, type AccessTokenInput, type Session } from "@/server/services/tokens";
import { emitActivity, type ActivityInput } from "@/server/services/activity-log";
import { DuplicateUserCodeError, mongoDeviceAuthStore } from "@/server/device-auth/mongo-store";

export { DuplicateUserCodeError };

export const DEVICE_CODE_TTL_SECONDS = 10 * 60;
/** What the CLI is told to wait between polls (RFC 8628 §3.2 `interval`). */
export const POLL_INTERVAL_SECONDS = 5;
/** Polls closer together than this, while pending, are told to slow down. */
export const MIN_POLL_GAP_MS = 2_000;

/** 20 consonants: no vowels means no words, and no 0/O or 1/I to confuse. */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;
const INSERT_ATTEMPTS = 3;

export type DeviceAuthStatus = "pending" | "approved" | "denied" | "consumed";

export type DeviceClient = {
  name: string;
  hostname: string | null;
  platform: string | null;
  version: string | null;
};

export type DeviceAuthorization = {
  id: string;
  deviceCodeHash: string;
  /** Normalised, with the dash: `BCDF-GHJK`. */
  userCode: string;
  client: DeviceClient;
  status: DeviceAuthStatus;
  userId: string | null;
  tenantId: string | null;
  createdAt: Date;
  expiresAt: Date;
  lastPolledAt: Date | null;
  decidedAt: Date | null;
};

export type NewDeviceAuthorization = Omit<DeviceAuthorization, "id">;

export type DeviceAuthStore = {
  /** Throws DuplicateUserCodeError when a live request already holds the code. */
  insert(record: NewDeviceAuthorization): Promise<void>;
  findByDeviceCodeHash(hash: string): Promise<DeviceAuthorization | null>;
  /** Only a pending, unexpired request. */
  findPendingByUserCode(userCode: string, now: Date): Promise<DeviceAuthorization | null>;
  /** pending → approved/denied. False when it was no longer pending. */
  decide(
    id: string,
    decision: { status: "approved" | "denied"; userId: string; tenantId: string; at: Date },
  ): Promise<boolean>;
  /** approved → consumed. False when someone else got there first. */
  consume(id: string, at: Date): Promise<boolean>;
  touchPoll(id: string, at: Date): Promise<void>;
};

export type DeviceAuthDeps = {
  store: DeviceAuthStore;
  identity: IdentityStore;
  issue: (input: AccessTokenInput) => Promise<Session>;
  emit: (input: ActivityInput) => Promise<void>;
  appUrl: () => string;
  now: () => Date;
  random: (bytes: number) => Buffer;
};

function resolve(overrides: Partial<DeviceAuthDeps> = {}): DeviceAuthDeps {
  return {
    store: overrides.store ?? mongoDeviceAuthStore(),
    identity: overrides.identity ?? mongoIdentityStore(),
    issue: overrides.issue ?? issueSession,
    emit: overrides.emit ?? emitActivity,
    appUrl: overrides.appUrl ?? (() => env().APP_URL),
    now: overrides.now ?? (() => new Date()),
    random: overrides.random ?? randomBytes,
  };
}

export const hashDeviceCode = (code: string): string =>
  createHash("sha256").update(code).digest("hex");

/**
 * What the CLI says about itself, made safe to render: control characters and
 * anything outside printable ASCII-ish text dropped, length capped. It is shown
 * to the person as a claim, never trusted.
 */
const clientText = (max: number) =>
  z
    .string()
    .transform((v) =>
      v
        .replace(/[^\p{L}\p{N} ._()/@+:-]/gu, "")
        .trim()
        .slice(0, max),
    )
    .optional();

export const startSchema = z
  .object({
    client: z
      .object({
        name: clientText(40),
        hostname: clientText(64),
        platform: clientText(32),
        version: clientText(32),
      })
      .strict()
      .optional(),
  })
  .strict();

export const userCodeSchema = z.object({ userCode: z.string().min(1).max(32) }).strict();

export const decisionSchema = z
  .object({ userCode: z.string().min(1).max(32), decision: z.enum(["approve", "deny"]) })
  .strict();

export const pollSchema = z.object({ deviceCode: z.string().min(1).max(128) }).strict();

/** Any spacing, case or dash the person typed → `BCDF-GHJK`, or null. */
export function normaliseUserCode(raw: string): string | null {
  const letters = raw.toUpperCase().replace(/[^A-Z]/g, "");
  if (letters.length !== USER_CODE_LENGTH) return null;
  for (const ch of letters) if (!USER_CODE_ALPHABET.includes(ch)) return null;
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

/** Unbiased: 256 is not a multiple of 20, so bytes ≥ 240 are rejected. */
function generateUserCode(random: (bytes: number) => Buffer): string {
  const out: string[] = [];
  while (out.length < USER_CODE_LENGTH) {
    for (const byte of random(16)) {
      if (byte >= 240) continue;
      out.push(USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]);
      if (out.length === USER_CODE_LENGTH) break;
    }
  }
  return `${out.slice(0, 4).join("")}-${out.slice(4).join("")}`;
}

const unknownCode = (): never => {
  throw new AppError("UNAUTHORIZED", "Invalid or expired device code");
};

const noSuchRequest = (): never => {
  throw new AppError(
    "NOT_FOUND",
    "No pending sign-in request has that code. Check the code in your terminal, or run `graft login` again.",
  );
};

// ── 1. The CLI asks ───────────────────────────────────────────────────────────

export type DeviceStart = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

export async function startDeviceAuthorization(
  input: unknown,
  overrides: Partial<DeviceAuthDeps> = {},
): Promise<DeviceStart> {
  const deps = resolve(overrides);
  const { client } = parse(startSchema, input, "body");
  const now = deps.now();

  for (let attempt = 1; ; attempt++) {
    const deviceCode = deps.random(32).toString("base64url");
    const userCode = generateUserCode(deps.random);
    try {
      await deps.store.insert({
        deviceCodeHash: hashDeviceCode(deviceCode),
        userCode,
        client: {
          name: client?.name || "Graft CLI",
          hostname: client?.hostname || null,
          platform: client?.platform || null,
          version: client?.version || null,
        },
        status: "pending",
        userId: null,
        tenantId: null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + DEVICE_CODE_TTL_SECONDS * 1000),
        lastPolledAt: null,
        decidedAt: null,
      });
      return {
        deviceCode,
        userCode,
        verificationUri: `${deps.appUrl().replace(/\/$/, "")}/device`,
        expiresIn: DEVICE_CODE_TTL_SECONDS,
        interval: POLL_INTERVAL_SECONDS,
      };
    } catch (error) {
      // 20^8 codes; a collision among the few live ones is rare, three in a
      // row is a broken random source, which should be loud.
      if (!(error instanceof DuplicateUserCodeError) || attempt >= INSERT_ATTEMPTS) throw error;
    }
  }
}

// ── 2. The person looks, then decides ────────────────────────────────────────

export type DevicePending = {
  userCode: string;
  client: DeviceClient;
  requestedAt: string;
  expiresAt: string;
};

async function pendingFor(userCode: string, deps: DeviceAuthDeps) {
  const code = normaliseUserCode(userCode);
  if (!code) return noSuchRequest();
  return (await deps.store.findPendingByUserCode(code, deps.now())) ?? noSuchRequest();
}

/** What the approval page shows before the person decides. Needs a session. */
export async function lookupDeviceAuthorization(
  _ctx: Ctx,
  input: unknown,
  overrides: Partial<DeviceAuthDeps> = {},
): Promise<DevicePending> {
  const deps = resolve(overrides);
  const { userCode } = parse(userCodeSchema, input, "body");
  const record = await pendingFor(userCode, deps);
  return {
    userCode: record.userCode,
    client: record.client,
    requestedAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
  };
}

/**
 * Binds the request to the deciding person's user and *current* tenant. Which
 * workspace the CLI lands in is therefore the one the browser is in — the
 * page says so, and the CLI can switch afterwards like the web app does.
 */
export async function decideDeviceAuthorization(
  ctx: Ctx,
  input: unknown,
  overrides: Partial<DeviceAuthDeps> = {},
): Promise<{ status: "approved" | "denied" }> {
  const deps = resolve(overrides);
  const { userCode, decision } = parse(decisionSchema, input, "body");
  const record = await pendingFor(userCode, deps);
  const status = decision === "approve" ? "approved" : "denied";
  const decided = await deps.store.decide(record.id, {
    status,
    userId: ctx.userId,
    tenantId: ctx.tenantId,
    at: deps.now(),
  });
  // Lost a race with another tab, or expired between lookup and click.
  if (!decided) return noSuchRequest();
  return { status };
}

// ── 3. The CLI collects ──────────────────────────────────────────────────────

export type DevicePoll =
  | { status: "pending" | "slow_down"; interval: number }
  | {
      status: "approved";
      accessToken: string;
      expiresAt: string;
      refreshToken: string;
      refreshExpiresIn: number;
    };

export async function pollDeviceAuthorization(
  input: unknown,
  overrides: Partial<DeviceAuthDeps> = {},
  requestId?: string,
): Promise<DevicePoll> {
  const deps = resolve(overrides);
  const { deviceCode } = parse(pollSchema, input, "body");
  const now = deps.now();
  const record = await deps.store.findByDeviceCodeHash(hashDeviceCode(deviceCode));

  // Unknown, used and expired all read the same to the caller.
  if (!record || record.status === "consumed") return unknownCode();
  if (record.status !== "approved" && record.expiresAt.getTime() <= now.getTime()) {
    return unknownCode();
  }
  if (record.status === "denied") {
    throw new AppError("FORBIDDEN", "The sign-in request was denied in the browser");
  }

  if (record.status === "pending") {
    const tooSoon =
      record.lastPolledAt !== null &&
      now.getTime() - record.lastPolledAt.getTime() < MIN_POLL_GAP_MS;
    await deps.store.touchPoll(record.id, now);
    return tooSoon
      ? { status: "slow_down", interval: POLL_INTERVAL_SECONDS + 5 }
      : { status: "pending", interval: POLL_INTERVAL_SECONDS };
  }

  // Approved. An approval is honoured until the request's own expiry plus one
  // poll interval, so a CLI that was mid-sleep at the deadline still collects.
  if (now.getTime() > record.expiresAt.getTime() + POLL_INTERVAL_SECONDS * 2000) {
    return unknownCode();
  }
  if (!record.userId || !record.tenantId) return unknownCode();
  if (!(await deps.store.consume(record.id, now))) return unknownCode();

  const identity = await deps.identity.resolve(record.tenantId, record.userId);
  // The membership ended between approval and collection.
  if (!identity) return unknownCode();

  const session = await deps.issue({
    tenantId: record.tenantId,
    userId: record.userId,
    roles: identity.roles,
    tier: identity.tier,
  });

  await deps.emit({
    tenantId: record.tenantId,
    actorType: "customer",
    actorId: record.userId,
    action: "account.login",
    ok: true,
    requestId: requestId ?? newRequestId(),
    context: { method: "device" },
  });

  return {
    status: "approved",
    accessToken: session.accessToken,
    expiresAt: session.expiresAt,
    refreshToken: session.refreshToken,
    refreshExpiresIn: session.refreshMaxAge,
  };
}
