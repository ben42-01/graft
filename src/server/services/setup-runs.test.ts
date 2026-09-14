/**
 * Guided setup run persistence — the semantics the page depends on: one
 * active run, a merge that cannot lose an earlier step's answer, and a finish
 * that is stamped once.
 */
import { ObjectId, type WithId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import type { Repository } from "@/server/repositories/base";
import {
  getActiveSetupRun,
  patchSetupRun,
  patchSetupRunSchema,
  startSetupRun,
  type SetupRunDoc,
} from "./setup-runs";

const TENANT = "000000000000000000000001";
const USER = "00000000000000000000000b";
const ENTITY = "0000000000000000000000e1";

const ctx: Ctx = createContext({
  requestId: "req-setup",
  tenantId: TENANT,
  userId: USER,
  roles: ["owner"],
  tier: "free",
});

/**
 * In-memory stand-in for the repository port. Unlike the onboarding fake this
 * holds *many* rows, because "the active run" is a filter over them and the
 * one-active-run rule is the thing worth proving.
 */
function fakeRepo() {
  const docs: WithId<SetupRunDoc>[] = [];
  const tenantId = new ObjectId(TENANT);

  const matches = (doc: WithId<SetupRunDoc>, filter: Record<string, unknown>): boolean =>
    Object.entries(filter).every(([key, value]) => {
      if (key === "_id") return doc._id.equals(value as ObjectId);
      if (key === "deletedAt") return true;
      return (doc as unknown as Record<string, unknown>)[key] === value;
    });

  const repo: Repository<SetupRunDoc> = {
    collectionName: "setup_runs",
    collection: vi.fn() as unknown as Repository<SetupRunDoc>["collection"],
    async find(_ctx, filter = {}) {
      return docs.filter((doc) => matches(doc, filter as Record<string, unknown>));
    },
    async findOne(_ctx, filter = {}) {
      return docs.find((doc) => matches(doc, filter as Record<string, unknown>)) ?? null;
    },
    async findById(_ctx, id) {
      return docs.find((doc) => doc._id.equals(id)) ?? null;
    },
    async count(_ctx, filter = {}) {
      return docs.filter((doc) => matches(doc, filter as Record<string, unknown>)).length;
    },
    async insertOne(_ctx, next) {
      const doc = { ...next, tenantId, _id: new ObjectId() } as unknown as WithId<SetupRunDoc>;
      docs.push(doc);
      return doc;
    },
    async updateOne(_ctx, filter, update) {
      const index = docs.findIndex((doc) => matches(doc, filter as Record<string, unknown>));
      if (index < 0) return null;
      const set = (update.$set ?? {}) as Partial<SetupRunDoc>;
      docs[index] = { ...docs[index], ...set };
      return docs[index];
    },
    async softDelete() {
      return false;
    },
    async listPage() {
      return { items: docs, meta: { limit: 25, hasMore: false, cursor: null } };
    },
  };

  return { repo, docs };
}

describe("patchSetupRunSchema", () => {
  it("accepts one step's outcome on its own", () => {
    expect(patchSetupRunSchema.safeParse({ thingLabel: "Boats" }).success).toBe(true);
    expect(patchSetupRunSchema.safeParse({ intent: "bookings" }).success).toBe(true);
  });

  it("rejects an intent the flow does not have", () => {
    expect(patchSetupRunSchema.safeParse({ intent: "invoicing" }).success).toBe(false);
  });

  it("rejects an empty body — nothing to update", () => {
    expect(patchSetupRunSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an id that is not an id, so a run cannot point at nonsense", () => {
    expect(patchSetupRunSchema.safeParse({ resourceEntityId: "boats" }).success).toBe(false);
    expect(patchSetupRunSchema.safeParse({ resourceEntityId: ENTITY }).success).toBe(true);
  });

  it("allows clearing a pointer, for a step redone from scratch", () => {
    expect(patchSetupRunSchema.safeParse({ formId: null }).success).toBe(true);
  });
});

describe("getActiveSetupRun", () => {
  it("answers null rather than inventing a run for a tenant who has none", async () => {
    const { repo } = fakeRepo();
    expect(await getActiveSetupRun(ctx, { repo })).toBeNull();
  });
});

describe("startSetupRun", () => {
  it("opens a run at the first step with nothing built yet", async () => {
    const { repo } = fakeRepo();
    const run = await startSetupRun(ctx, { repo });
    expect(run.step).toBe("thing");
    expect(run.intent).toBeNull();
    expect(run.resourceEntityId).toBeNull();
    expect(run.recordCount).toBe(0);
  });

  it("leaves exactly one run active when a second is started", async () => {
    const { repo, docs } = fakeRepo();
    const first = await startSetupRun(ctx, { repo });
    const second = await startSetupRun(ctx, { repo });

    expect(second.id).not.toBe(first.id);
    expect(docs).toHaveLength(2);
    expect(docs.filter((doc) => doc.closedAt === null)).toHaveLength(1);
    expect((await getActiveSetupRun(ctx, { repo }))?.id).toBe(second.id);
  });

  it("keeps the superseded run rather than deleting it — its entity still exists", async () => {
    const { repo, docs } = fakeRepo();
    await patchSetupRun(ctx, { thingLabel: "Kilns", resourceEntityId: ENTITY }, { repo });
    await startSetupRun(ctx, { repo });
    expect(docs[0].thingLabel).toBe("Kilns");
    expect(docs[0].resourceEntityId).toBe(ENTITY);
  });
});

describe("patchSetupRun", () => {
  it("merges step by step, so a later step never clears an earlier answer", async () => {
    const { repo } = fakeRepo();
    await patchSetupRun(ctx, { thingLabel: "Rehearsal rooms" }, { repo });
    await patchSetupRun(ctx, { intent: "bookings", step: "shape" }, { repo });
    const run = await patchSetupRun(
      ctx,
      { resourceEntityId: ENTITY, step: "records" },
      { repo },
    );

    expect(run.thingLabel).toBe("Rehearsal rooms");
    expect(run.intent).toBe("bookings");
    expect(run.resourceEntityId).toBe(ENTITY);
    expect(run.step).toBe("records");
  });

  it("starts a run for a tenant who has none, rather than failing the step", async () => {
    const { repo } = fakeRepo();
    const run = await patchSetupRun(ctx, { thingLabel: "Dog grooming slots" }, { repo });
    expect(run.id).toBeTruthy();
    expect(run.thingLabel).toBe("Dog grooming slots");
  });

  it("stamps the finish once and closes the run", async () => {
    const { repo } = fakeRepo();
    await patchSetupRun(ctx, { thingLabel: "Vans" }, { repo });
    const finished = await patchSetupRun(ctx, { step: "done", completed: true }, { repo });

    expect(finished.completedAt).not.toBeNull();
    // Closed, so the next visit offers a fresh run instead of reopening this.
    expect(await getActiveSetupRun(ctx, { repo })).toBeNull();
  });

  it("never rewrites the finish stamp of a run revisited afterwards", async () => {
    const { repo, docs } = fakeRepo();
    await patchSetupRun(ctx, { thingLabel: "Vans" }, { repo });
    const first = await patchSetupRun(ctx, { step: "done", completed: true }, { repo });

    // A closed run has no active run to patch, so this opens a new one — the
    // finished run's own stamp is untouched either way.
    await patchSetupRun(ctx, { completed: true }, { repo });
    expect(docs[0].completedAt).toEqual(first.completedAt);
  });

  it("records counts the later steps gate on", async () => {
    const { repo } = fakeRepo();
    const run = await patchSetupRun(ctx, { recordCount: 4, bookableRecordCount: 1 }, { repo });
    expect(run.recordCount).toBe(4);
    expect(run.bookableRecordCount).toBe(1);
  });
});
