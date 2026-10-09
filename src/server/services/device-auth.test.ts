/**
 * The CLI's browser sign-in, driven through an in-memory store.
 *
 * Every security property claimed in device-auth.ts's header has a test here
 * that states it. The Mongo store is the thin translation layer and is
 * exercised end to end by bruno/cli-auth/.
 */
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createContext } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import type { Session } from "@/server/services/tokens";
import {
  DEVICE_CODE_TTL_SECONDS,
  DuplicateUserCodeError,
  MIN_POLL_GAP_MS,
  POLL_INTERVAL_SECONDS,
  USER_CODE_ALPHABET,
  decideDeviceAuthorization,
  hashDeviceCode,
  lookupDeviceAuthorization,
  normaliseUserCode,
  pollDeviceAuthorization,
  startDeviceAuthorization,
  type DeviceAuthDeps,
  type DeviceAuthorization,
  type DeviceAuthStore,
} from "./device-auth";

const TENANT = "000000000000000000000001";
const OTHER_TENANT = "000000000000000000000002";
const USER = "00000000000000000000000b";

function memoryStore() {
  const rows: DeviceAuthorization[] = [];
  let next = 1;
  const store: DeviceAuthStore & { rows: DeviceAuthorization[] } = {
    rows,
    async insert(record) {
      if (rows.some((r) => r.status === "pending" && r.userCode === record.userCode)) {
        throw new DuplicateUserCodeError();
      }
      rows.push({ ...record, id: String(next++).padStart(24, "0") });
    },
    async findByDeviceCodeHash(hash) {
      return rows.find((r) => r.deviceCodeHash === hash) ?? null;
    },
    async findPendingByUserCode(userCode, now) {
      return (
        rows.find(
          (r) => r.userCode === userCode && r.status === "pending" && r.expiresAt > now,
        ) ?? null
      );
    },
    async decide(id, { status, userId, tenantId, at }) {
      const row = rows.find((r) => r.id === id);
      if (!row || row.status !== "pending" || row.expiresAt <= at) return false;
      Object.assign(row, { status, userId, tenantId, decidedAt: at });
      return true;
    },
    async consume(id, at) {
      const row = rows.find((r) => r.id === id);
      if (!row || row.status !== "approved") return false;
      Object.assign(row, { status: "consumed", lastPolledAt: at });
      return true;
    },
    async touchPoll(id, at) {
      const row = rows.find((r) => r.id === id);
      if (row) row.lastPolledAt = at;
    },
  };
  return store;
}

const session: Session = {
  accessToken: "access.jwt.here",
  expiresAt: "2026-10-09T10:15:00.000Z",
  refreshToken: `${TENANT}.refresh-secret`,
  refreshMaxAge: 2_592_000,
  claims: {
    sub: USER,
    tid: TENANT,
    roles: ["owner"],
    tier: "premium",
    iat: 0,
    exp: 900,
    jti: "jti",
  },
};

let store: ReturnType<typeof memoryStore>;
let clock: Date;
let deps: Partial<DeviceAuthDeps>;
const issue = vi.fn(async () => session);
const emit = vi.fn(async () => {});
const resolveIdentity = vi.fn(async () => ({
  roles: ["owner"] as const,
  tier: "premium" as const,
}));

const ctx = (tenantId = TENANT) =>
  createContext({
    requestId: "req-device-1",
    tenantId,
    userId: USER,
    roles: ["member"],
    tier: "free",
  });

const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

const codeOf = (error: unknown) => (error instanceof AppError ? error.code : String(error));

beforeEach(() => {
  store = memoryStore();
  clock = new Date("2026-10-09T10:00:00.000Z");
  issue.mockClear();
  emit.mockClear();
  resolveIdentity.mockClear();
  deps = {
    store,
    issue,
    emit,
    identity: { resolve: resolveIdentity },
    appUrl: () => "https://graft.example/",
    now: () => clock,
    random: randomBytes,
  };
});

async function started() {
  return startDeviceAuthorization({ client: { name: "graft", hostname: "laptop" } }, deps);
}

describe("start", () => {
  it("hands back a secret device code, a short user code and where to type it", async () => {
    const result = await started();
    expect(result.deviceCode.length).toBeGreaterThanOrEqual(40);
    expect(result.userCode).toMatch(
      new RegExp(`^[${USER_CODE_ALPHABET}]{4}-[${USER_CODE_ALPHABET}]{4}$`),
    );
    expect(result.verificationUri).toBe("https://graft.example/device");
    expect(result.expiresIn).toBe(DEVICE_CODE_TTL_SECONDS);
    expect(result.interval).toBe(POLL_INTERVAL_SECONDS);
  });

  it("stores only the hash of the device code", async () => {
    const { deviceCode } = await started();
    expect(store.rows[0].deviceCodeHash).toBe(hashDeviceCode(deviceCode));
    expect(JSON.stringify(store.rows)).not.toContain(deviceCode);
  });

  it("never puts the user code in the verification link", async () => {
    const { userCode, verificationUri } = await started();
    expect(verificationUri).not.toContain(userCode);
    expect(verificationUri).not.toContain("?");
  });

  it("sanitises what the client claims about itself before anyone renders it", async () => {
    await startDeviceAuthorization(
      {
        client: {
          name: "<script>x</script>",
          hostname: "pwn\u0007\nbox",
          version: "1".repeat(99),
        },
      },
      deps,
    );
    const { client } = store.rows[0];
    expect(client.name).toBe("scriptx/script");
    expect(client.hostname).toBe("pwnbox");
    expect(client.version).toHaveLength(32);
    expect(client.platform).toBeNull();
  });

  it("names an anonymous client 'Graft CLI'", async () => {
    await startDeviceAuthorization({}, deps);
    expect(store.rows[0].client.name).toBe("Graft CLI");
  });

  it("refuses fields it does not know", async () => {
    await expect(startDeviceAuthorization({ tenantId: TENANT }, deps)).rejects.toSatisfy(
      (e) => codeOf(e) === "VALIDATION_FAILED",
    );
  });

  it("draws a new user code when the first collides with a live one", async () => {
    const fixed = Buffer.alloc(32, 1); // always the same user code
    const fresh = vi.fn((n: number) =>
      fresh.mock.calls.length <= 2 ? Buffer.alloc(n, 1) : randomBytes(n),
    );
    await startDeviceAuthorization({}, { ...deps, random: () => fixed });
    await startDeviceAuthorization({}, { ...deps, random: fresh });
    expect(store.rows).toHaveLength(2);
    expect(store.rows[0].userCode).not.toBe(store.rows[1].userCode);
  });

  it("gives up loudly after three collisions — that is a broken random source", async () => {
    const fixed = () => Buffer.alloc(32, 1);
    await startDeviceAuthorization({}, { ...deps, random: fixed });
    await expect(
      startDeviceAuthorization({}, { ...deps, random: fixed }),
    ).rejects.toBeInstanceOf(DuplicateUserCodeError);
  });

  it("does not bias the alphabet: bytes 240–255 are thrown away", async () => {
    // 255 % 20 = 15 would be 'R'; it must be skipped, leaving 0 → 'B'.
    const random = (n: number) =>
      n === 16 ? Buffer.from([255, ...Array(15).fill(0)]) : randomBytes(n);
    const { userCode } = await startDeviceAuthorization({}, { ...deps, random });
    expect(userCode).toBe("BBBB-BBBB");
  });
});

describe("normaliseUserCode", () => {
  it.each([
    ["bcdf-ghjk", "BCDF-GHJK"],
    [" BCDF GHJK ", "BCDF-GHJK"],
    ["bcdfghjk", "BCDF-GHJK"],
  ])("accepts %j", (raw, expected) => expect(normaliseUserCode(raw)).toBe(expected));

  it.each(["BCDF-GHJ", "BCDF-GHJKL", "ABCD-EFGH", "1234-5678", ""])("rejects %j", (raw) =>
    expect(normaliseUserCode(raw)).toBeNull(),
  );
});

describe("lookup and decision", () => {
  it("shows a signed-in person which client is asking", async () => {
    const { userCode } = await started();
    const pending = await lookupDeviceAuthorization(
      ctx(),
      { userCode: userCode.toLowerCase() },
      deps,
    );
    expect(pending.client).toEqual({
      name: "graft",
      hostname: "laptop",
      platform: null,
      version: null,
    });
    expect(pending.userCode).toBe(userCode);
  });

  it("does not find a code that does not exist, is malformed, or has expired", async () => {
    const { userCode } = await started();
    for (const code of ["BCDF-GHJK", "nonsense"]) {
      await expect(
        lookupDeviceAuthorization(ctx(), { userCode: code }, deps),
      ).rejects.toSatisfy((e) => codeOf(e) === "NOT_FOUND");
    }
    advance(DEVICE_CODE_TTL_SECONDS * 1000);
    await expect(lookupDeviceAuthorization(ctx(), { userCode }, deps)).rejects.toSatisfy(
      (e) => codeOf(e) === "NOT_FOUND",
    );
  });

  it("binds an approval to the approver's user and current tenant", async () => {
    const { userCode } = await started();
    await expect(
      decideDeviceAuthorization(ctx(OTHER_TENANT), { userCode, decision: "approve" }, deps),
    ).resolves.toEqual({ status: "approved" });
    expect(store.rows[0]).toMatchObject({
      status: "approved",
      userId: USER,
      tenantId: OTHER_TENANT,
    });
  });

  it("decides once — a second click, in any tab, finds nothing pending", async () => {
    const { userCode } = await started();
    await decideDeviceAuthorization(ctx(), { userCode, decision: "deny" }, deps);
    await expect(
      decideDeviceAuthorization(ctx(), { userCode, decision: "approve" }, deps),
    ).rejects.toSatisfy((e) => codeOf(e) === "NOT_FOUND");
    expect(store.rows[0].status).toBe("denied");
  });

  it("reports the race when the request expires between lookup and click", async () => {
    const { userCode } = await started();
    const raced = { ...deps, store: { ...store, decide: async () => false } };
    await expect(
      decideDeviceAuthorization(ctx(), { userCode, decision: "approve" }, raced),
    ).rejects.toSatisfy((e) => codeOf(e) === "NOT_FOUND");
  });
});

describe("poll", () => {
  it("says pending, then slow down when polled too fast", async () => {
    const { deviceCode } = await started();
    await expect(pollDeviceAuthorization({ deviceCode }, deps)).resolves.toEqual({
      status: "pending",
      interval: POLL_INTERVAL_SECONDS,
    });
    advance(MIN_POLL_GAP_MS - 1);
    await expect(pollDeviceAuthorization({ deviceCode }, deps)).resolves.toMatchObject({
      status: "slow_down",
    });
    advance(MIN_POLL_GAP_MS);
    await expect(pollDeviceAuthorization({ deviceCode }, deps)).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("treats unknown and expired codes alike", async () => {
    const { deviceCode } = await started();
    await expect(pollDeviceAuthorization({ deviceCode: "made-up" }, deps)).rejects.toSatisfy(
      (e) => codeOf(e) === "UNAUTHORIZED",
    );
    advance(DEVICE_CODE_TTL_SECONDS * 1000);
    await expect(pollDeviceAuthorization({ deviceCode }, deps)).rejects.toSatisfy(
      (e) => codeOf(e) === "UNAUTHORIZED",
    );
  });

  it("is FORBIDDEN once the person denied it", async () => {
    const { deviceCode, userCode } = await started();
    await decideDeviceAuthorization(ctx(), { userCode, decision: "deny" }, deps);
    await expect(pollDeviceAuthorization({ deviceCode }, deps)).rejects.toSatisfy(
      (e) => codeOf(e) === "FORBIDDEN",
    );
  });

  it("mints an ordinary session with roles and tier re-read at issue time", async () => {
    const { deviceCode, userCode } = await started();
    await decideDeviceAuthorization(ctx(), { userCode, decision: "approve" }, deps);
    const result = await pollDeviceAuthorization({ deviceCode }, deps, "req-poll-1");

    expect(result).toEqual({
      status: "approved",
      accessToken: session.accessToken,
      expiresAt: session.expiresAt,
      refreshToken: session.refreshToken,
      refreshExpiresIn: session.refreshMaxAge,
    });
    expect(resolveIdentity).toHaveBeenCalledWith(TENANT, USER);
    // The approver's ctx said member/free; the database says owner/premium.
    expect(issue).toHaveBeenCalledWith({
      tenantId: TENANT,
      userId: USER,
      roles: ["owner"],
      tier: "premium",
    });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "account.login",
        context: { method: "device" },
        requestId: "req-poll-1",
      }),
    );
  });

  it("is single use: the second poll after approval gets nothing", async () => {
    const { deviceCode, userCode } = await started();
    await decideDeviceAuthorization(ctx(), { userCode, decision: "approve" }, deps);
    await pollDeviceAuthorization({ deviceCode }, deps);
    await expect(pollDeviceAuthorization({ deviceCode }, deps)).rejects.toSatisfy(
      (e) => codeOf(e) === "UNAUTHORIZED",
    );
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it("mints nothing when a concurrent poll consumed it first", async () => {
    const { deviceCode, userCode } = await started();
    await decideDeviceAuthorization(ctx(), { userCode, decision: "approve" }, deps);
    const raced = { ...deps, store: { ...store, consume: async () => false } };
    await expect(pollDeviceAuthorization({ deviceCode }, raced)).rejects.toSatisfy(
      (e) => codeOf(e) === "UNAUTHORIZED",
    );
    expect(issue).not.toHaveBeenCalled();
  });

  it("mints nothing when the membership ended after approval", async () => {
    const { deviceCode, userCode } = await started();
    await decideDeviceAuthorization(ctx(), { userCode, decision: "approve" }, deps);
    resolveIdentity.mockResolvedValueOnce(null as never);
    await expect(pollDeviceAuthorization({ deviceCode }, deps)).rejects.toSatisfy(
      (e) => codeOf(e) === "UNAUTHORIZED",
    );
    expect(issue).not.toHaveBeenCalled();
  });

  it("lets a CLI that was mid-sleep at the deadline still collect an approval", async () => {
    const { deviceCode, userCode } = await started();
    advance(DEVICE_CODE_TTL_SECONDS * 1000 - 1000);
    await decideDeviceAuthorization(ctx(), { userCode, decision: "approve" }, deps);
    advance(POLL_INTERVAL_SECONDS * 1000);
    await expect(pollDeviceAuthorization({ deviceCode }, deps)).resolves.toMatchObject({
      status: "approved",
    });
  });

  it("but not long after", async () => {
    const { deviceCode, userCode } = await started();
    await decideDeviceAuthorization(ctx(), { userCode, decision: "approve" }, deps);
    advance((DEVICE_CODE_TTL_SECONDS + 60) * 1000);
    await expect(pollDeviceAuthorization({ deviceCode }, deps)).rejects.toSatisfy(
      (e) => codeOf(e) === "UNAUTHORIZED",
    );
  });

  it("refuses an approved row that somehow lost its user or tenant", async () => {
    const { deviceCode } = await started();
    Object.assign(store.rows[0], { status: "approved", userId: null });
    await expect(pollDeviceAuthorization({ deviceCode }, deps)).rejects.toSatisfy(
      (e) => codeOf(e) === "UNAUTHORIZED",
    );
  });
});
