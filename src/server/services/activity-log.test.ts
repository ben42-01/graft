import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GRAFT-29.1 — the activity log's write path.
 *
 * This collection is read from `/admin` (GRAFT-29.2) across tenant boundaries,
 * so the allow-list discipline below is the security control, not house style.
 * Three separate boundaries are under test, and they fail differently on
 * purpose:
 *
 *  - **The base envelope** is built field by field from `ACTIVITY_FIELDS`, so a
 *    caller who passes `userEmail` at the top level cannot widen the row (AC1).
 *    Extra top-level keys are dropped silently — they are the caller's noise,
 *    not a claim about the row.
 *  - **`context` extras are stripped** (AC3). A stray `password` does not land,
 *    and does not stop the write either: losing the activity row because a
 *    caller over-shared is the wrong trade.
 *  - **A PII field on the wrong family throws** (AC4). This is deliberately
 *    louder than AC3: `context.to` is the single permitted address field in the
 *    entire taxonomy and it belongs to `notify.email` alone. An address
 *    reaching `account.*` is a bug at the call site (GRAFT-29.4), and a
 *    silently dropped one is a bug nobody ever notices.
 *
 * The registry (AC2) is closed for the same reason: `GET /admin/activities`
 * filters by action, so a typo that created an untyped row would be a row the
 * read API can never surface.
 */

const insertOne = vi.fn(async (_doc: Record<string, unknown>) => ({ insertedId: "x" }));
const collection = vi.fn(() => ({ insertOne }));

vi.mock("@/server/db/mongo", () => ({
  getDb: async () => ({ collection }),
}));

import {
  ACTIVITIES_COLLECTION,
  ACTIVITY_FIELDS,
  ACTIVITY_REGISTRY,
  mongoActivityStore,
  recordActivity,
  type ActivityEntry,
  type ActivityStore,
} from "./activity-log";

beforeEach(() => {
  insertOne.mockClear();
  collection.mockClear();
});

const AT = new Date("2026-09-19T10:00:00.000Z");
const TENANT_ID = "000000000000000000000002";
const ACTOR_ID = "000000000000000000000050";

/** Collects what was appended, and records that an append happened at all. */
function capture() {
  const appended: ActivityEntry[] = [];
  const store: ActivityStore = { append: async (entry) => void appended.push(entry) };
  return { appended, store };
}

/** A valid `entity.created` call — the shape most tests vary one field of. */
const entityCreated = {
  tenantId: TENANT_ID,
  actorType: "customer" as const,
  actorId: ACTOR_ID,
  action: "entity.created",
  ok: true,
  requestId: "req-1",
  context: { entityDefId: "def-1", entityType: "contact", recordId: "rec-1" },
};

describe("recordActivity — base envelope (AC1)", () => {
  it("writes exactly the contracted fields and nothing else", async () => {
    const { appended, store } = capture();

    await recordActivity(entityCreated, { activities: store, now: () => AT });

    expect(appended).toHaveLength(1);
    expect(appended[0]).toEqual({
      tenantId: TENANT_ID,
      actorType: "customer",
      actorId: ACTOR_ID,
      action: "entity.created",
      ok: true,
      requestId: "req-1",
      at: AT,
      context: { entityDefId: "def-1", entityType: "contact", recordId: "rec-1" },
    });
    // The field list is the contract, not an incidental shape.
    expect(Object.keys(appended[0]!).sort()).toEqual([...ACTIVITY_FIELDS].sort());
  });

  /**
   * Phrased the way PII actually arrives: a caller casts past the type and
   * hands the writer a whole user object. `as never` because the type already
   * refuses this — the test is about what happens when someone gets past it.
   */
  it("drops unlisted top-level keys, including PII", async () => {
    const { appended, store } = capture();

    await recordActivity(
      {
        ...entityCreated,
        userEmail: "customer@qa.test",
        name: "QA Customer",
        body: { password: "hunter2" },
      } as never,
      { activities: store, now: () => AT },
    );

    const written = JSON.stringify(appended[0]);
    expect(written).not.toContain("@");
    expect(written).not.toContain("QA Customer");
    expect(written).not.toContain("hunter2");
    expect(Object.keys(appended[0]!).sort()).toEqual([...ACTIVITY_FIELDS].sort());
  });
});

describe("recordActivity — the action registry (AC2)", () => {
  /**
   * Every leaf in the taxonomy is asserted to be callable, rather than a
   * hand-picked few. The table in the issue is binding on GRAFT-29.2/29.3/29.4,
   * so a leaf quietly renamed here would break three downstream issues; this
   * test is what makes the rename visible.
   */
  it("accepts every registered action in the taxonomy", async () => {
    const sampleContext: Record<string, Record<string, unknown>> = {
      "notify.email": { template: "welcome", to: "customer@qa.test" },
      "billing.subscription": { fromTier: "free", toTier: "premium" },
      "billing.payment": { amountCents: 1200, currency: "EUR" },
      account: { method: "password" },
      entity: { entityDefId: "def-1", entityType: "contact", recordId: "rec-1" },
    };

    for (const [family, def] of Object.entries(ACTIVITY_REGISTRY)) {
      for (const leaf of def.actions) {
        const { appended, store } = capture();
        await recordActivity(
          {
            tenantId: TENANT_ID,
            actorType: "system",
            actorId: null,
            action: `${family}.${leaf}`,
            ok: true,
            requestId: "req-registry",
            context: sampleContext[family]!,
          },
          { activities: store, now: () => AT },
        );
        expect(appended[0]!.action).toBe(`${family}.${leaf}`);
      }
    }
  });

  it("rejects an unregistered leaf inside a real family, before any write", async () => {
    const { appended, store } = capture();

    await expect(
      recordActivity(
        {
          tenantId: TENANT_ID,
          actorType: "system",
          actorId: null,
          action: "billing.subscription.pause",
          ok: true,
          requestId: "req-2",
          context: {},
        },
        { activities: store, now: () => AT },
      ),
    ).rejects.toThrow(/billing\.subscription\.pause/);

    // "before any write happens" is the half of AC2 that matters: a rejected
    // action must not leave a partial row behind.
    expect(appended).toHaveLength(0);
  });

  it("rejects an action in no family at all", async () => {
    const { appended, store } = capture();
    await expect(
      recordActivity(
        { ...entityCreated, action: "widget.exploded" },
        { activities: store, now: () => AT },
      ),
    ).rejects.toThrow();
    expect(appended).toHaveLength(0);
  });
});

describe("recordActivity — context validation (AC3)", () => {
  it("stores only the fields the family schema names, stripping extras", async () => {
    const { appended, store } = capture();

    await recordActivity(
      {
        ...entityCreated,
        context: { ...entityCreated.context, password: "hunter2", internalNote: "nope" },
      },
      { activities: store, now: () => AT },
    );

    expect(appended[0]!.context).toEqual({
      entityDefId: "def-1",
      entityType: "contact",
      recordId: "rec-1",
    });
    expect(JSON.stringify(appended[0])).not.toContain("hunter2");
  });

  it("rejects a context that is missing a field its family requires", async () => {
    const { appended, store } = capture();
    await expect(
      recordActivity(
        { ...entityCreated, context: { entityType: "contact" } },
        { activities: store, now: () => AT },
      ),
    ).rejects.toThrow();
    expect(appended).toHaveLength(0);
  });
});

describe("recordActivity — the PII boundary (AC4)", () => {
  it("permits `to` on notify.email, the one family that may carry an address", async () => {
    const { appended, store } = capture();

    await recordActivity(
      {
        tenantId: TENANT_ID,
        actorType: "system",
        actorId: null,
        action: "notify.email.sent",
        ok: true,
        requestId: "req-3",
        context: { template: "welcome", to: "customer@qa.test", messageId: "msg-1" },
      },
      { activities: store, now: () => AT },
    );

    expect(appended[0]!.context).toEqual({
      template: "welcome",
      to: "customer@qa.test",
      messageId: "msg-1",
    });
  });

  /**
   * The AC4 claim, from both directions the issue names. Note this THROWS
   * rather than stripping, unlike the AC3 extras above — an address on the
   * wrong family is a loud bug, never a silent drop.
   */
  it.each([
    ["account.signup", { method: "password" }],
    ["entity.created", { entityDefId: "def-1", entityType: "contact", recordId: "rec-1" }],
  ])("throws when an address reaches %s", async (action, base) => {
    const { appended, store } = capture();

    await expect(
      recordActivity(
        {
          tenantId: TENANT_ID,
          actorType: "customer",
          actorId: ACTOR_ID,
          action,
          ok: true,
          requestId: "req-4",
          context: { ...base, to: "customer@qa.test" },
        },
        { activities: store, now: () => AT },
      ),
    ).rejects.toThrow(/to/);

    expect(appended).toHaveLength(0);
  });

  it("names no free-text address field on any family but notify.email", () => {
    for (const [family, def] of Object.entries(ACTIVITY_REGISTRY)) {
      const keys = Object.keys(def.context.shape);
      if (family === "notify.email") {
        expect(keys).toContain("to");
      } else {
        expect(keys).not.toContain("to");
        expect(keys).not.toContain("email");
      }
    }
  });
});

describe("recordActivity — actor and tenant (AC5)", () => {
  it("accepts a null actorId for a system-fired action", async () => {
    const { appended, store } = capture();

    await recordActivity(
      {
        tenantId: TENANT_ID,
        actorType: "system",
        actorId: null,
        action: "billing.subscription.expire",
        ok: true,
        requestId: "req-5",
        context: { fromTier: "premium", toTier: "free" },
      },
      { activities: store, now: () => AT },
    );

    expect(appended[0]!.actorId).toBeNull();
    expect(appended[0]!.actorType).toBe("system");
  });

  it("defaults a missing actorId to null rather than dropping the field", async () => {
    const { appended, store } = capture();
    const { actorId: _drop, ...noActor } = entityCreated;
    await recordActivity(noActor, { activities: store, now: () => AT });
    expect(appended[0]!.actorId).toBeNull();
    expect(Object.keys(appended[0]!).sort()).toEqual([...ACTIVITY_FIELDS].sort());
  });

  it.each(["customer", "system", "admin"])("accepts actorType %s", async (actorType) => {
    const { appended, store } = capture();
    await recordActivity(
      { ...entityCreated, actorType: actorType as never },
      { activities: store, now: () => AT },
    );
    expect(appended[0]!.actorType).toBe(actorType);
  });

  it("rejects an unknown actorType", async () => {
    const { appended, store } = capture();
    await expect(
      recordActivity(
        { ...entityCreated, actorType: "robot" as never },
        { activities: store, now: () => AT },
      ),
    ).rejects.toThrow();
    expect(appended).toHaveLength(0);
  });

  /**
   * Unlike `admin_audit_log`, which is deliberately global, this collection
   * never stores a tenant-less row — GRAFT-29.2 reads it per tenant, and a row
   * with no tenant is a row that surface can never attribute.
   */
  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
  ])("rejects a %s tenantId", async (_label, tenantId) => {
    const { appended, store } = capture();
    await expect(
      recordActivity(
        { ...entityCreated, tenantId: tenantId as never },
        { activities: store, now: () => AT },
      ),
    ).rejects.toThrow();
    expect(appended).toHaveLength(0);
  });
});

describe("recordActivity — the clock (AC6)", () => {
  it("stamps `at` from the injected clock, ignoring any caller value", async () => {
    const { appended, store } = capture();

    await recordActivity(
      { ...entityCreated, at: new Date("1999-01-01T00:00:00.000Z") } as never,
      { activities: store, now: () => AT },
    );

    expect(appended[0]!.at).toEqual(AT);
  });
});

describe("recordActivity — write failures (AC7)", () => {
  /**
   * Whether a failed activity write should fail the parent operation is the
   * caller's call to make (GRAFT-29.4), so this function must not make it by
   * swallowing. The error propagates unchanged.
   */
  it("propagates a store failure rather than swallowing it", async () => {
    const boom = new Error("Mongo unreachable");
    const store: ActivityStore = {
      append: async () => {
        throw boom;
      },
    };

    await expect(
      recordActivity(entityCreated, { activities: store, now: () => AT }),
    ).rejects.toThrow(boom);
  });
});

describe("mongoActivityStore", () => {
  it("appends to the activities collection and exposes no other verb", async () => {
    const store = mongoActivityStore();
    expect(Object.keys(store)).toEqual(["append"]);

    await store.append({
      tenantId: TENANT_ID,
      actorType: "customer",
      actorId: ACTOR_ID,
      action: "entity.created",
      ok: true,
      requestId: "req-9",
      at: AT,
      context: { entityDefId: "def-1", entityType: "contact", recordId: "rec-1" },
    });

    expect(collection).toHaveBeenCalledWith(ACTIVITIES_COLLECTION);
    expect(insertOne).toHaveBeenCalledTimes(1);
    const doc = insertOne.mock.calls[0]![0]!;
    expect(doc).toMatchObject({
      action: "entity.created",
      requestId: "req-9",
      at: AT,
      ok: true,
    });
    // Ids are stored as ObjectIds, as everywhere else in the schema, so the
    // read API in GRAFT-29.2 joins to `tenants` and `users` without a cast.
    expect(String(doc.tenantId)).toBe(TENANT_ID);
    expect(String(doc.actorId)).toBe(ACTOR_ID);
  });

  it("stores a null actorId as null rather than casting it", async () => {
    await mongoActivityStore().append({
      tenantId: TENANT_ID,
      actorType: "system",
      actorId: null,
      action: "billing.subscription.expire",
      ok: true,
      requestId: "req-10",
      at: AT,
      context: {},
    });
    expect(insertOne.mock.calls[0]![0]!.actorId).toBeNull();
  });
});
