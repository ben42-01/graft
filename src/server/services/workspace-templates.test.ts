/**
 * Applying a workspace template — the guarantees the wizard relies on: the
 * plan is priced before anything is written, a failure part-way can be
 * resumed without duplicating what was made, and nothing the tenant already
 * owns is ever adopted.
 */
import { ObjectId, type WithId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import type { Repository } from "@/server/repositories/base";
import type { Meter, QuotaResult } from "./meters";
import {
  applyWorkspaceTemplate,
  listWorkspaceTemplates,
  previewWorkspaceTemplate,
  type TemplateRunDoc,
  type WorkspaceTemplateDeps,
} from "./workspace-templates";

const TENANT = "000000000000000000000001";

const ctx: Ctx = createContext({
  requestId: "req-templates",
  tenantId: TENANT,
  userId: "00000000000000000000000b",
  roles: ["owner"],
  tier: "free",
});

function fakeRuns() {
  const docs: WithId<TemplateRunDoc>[] = [];
  // A copy, as the driver would return — never the stored row itself.
  // (`structuredClone` alone would turn the ObjectId into a plain object.)
  const copy = (doc: WithId<TemplateRunDoc>) => ({
    ...doc,
    created: structuredClone(doc.created),
  });
  const find = (filter: Record<string, unknown>) =>
    docs.find((doc) => !filter._id || doc._id.equals(filter._id as ObjectId)) ?? null;
  const repo = {
    collectionName: "template_runs",
    async findById(_ctx: Ctx, id: string | ObjectId) {
      const doc = docs.find((candidate) => candidate._id.equals(id));
      return doc ? copy(doc) : null;
    },
    async insertOne(_ctx: Ctx, next: unknown) {
      const doc = {
        ...(next as object),
        tenantId: new ObjectId(TENANT),
        _id: new ObjectId(),
      } as WithId<TemplateRunDoc>;
      docs.push(doc);
      return copy(doc);
    },
    async updateOne(_ctx: Ctx, filter: Record<string, unknown>, update: { $set?: object }) {
      const doc = find(filter);
      if (!doc) return null;
      Object.assign(doc, structuredClone(update.$set ?? {}));
      return copy(doc);
    },
  } as unknown as Repository<TemplateRunDoc>;
  return { repo, docs };
}

type Limits = Partial<Record<Meter, number | null>>;

/** Everything a real apply touches, recorded; `failOn` makes one call throw. */
function harness(
  options: {
    limits?: Limits;
    existingKeys?: string[];
    existingSlugs?: string[];
    failOn?: { step: "createForm" | "createPool"; times: number };
  } = {},
) {
  const runs = fakeRuns();
  const calls: { step: string; input: unknown }[] = [];
  let failures = options.failOn?.times ?? 0;
  const maybeFail = (step: string) => {
    if (options.failOn?.step === step && failures > 0) {
      failures--;
      throw new AppError("INTERNAL", "Simulated failure");
    }
  };
  const id = () => new ObjectId().toHexString();

  const limits: Limits = {
    entities: 3,
    records: 2_000,
    internal_forms: 3,
    active_forms: 2,
    ...options.limits,
  };

  const deps: Partial<WorkspaceTemplateDeps> = {
    runs: runs.repo,
    createEntity: vi.fn(async (_ctx, input) => {
      calls.push({ step: "createEntity", input });
      return { id: id() };
    }),
    getEntityByKey: vi.fn(async (_ctx, key) =>
      options.existingKeys?.includes(key) ? { id: id() } : null,
    ),
    createRecord: vi.fn(async (_ctx, entityId, data) => {
      calls.push({ step: "createRecord", input: { entityId, data } });
      return { id: id() };
    }),
    createPool: vi.fn(async (_ctx, input) => {
      maybeFail("createPool");
      calls.push({ step: "createPool", input });
      return { id: id() };
    }),
    createForm: vi.fn(async (_ctx, input) => {
      maybeFail("createForm");
      calls.push({ step: "createForm", input });
      return { id: id() };
    }),
    publishForm: vi.fn(async (_ctx, formId) => {
      calls.push({ step: "publishForm", input: formId });
      return { id: formId, publicSlug: `acme/${formId}` };
    }),
    formSlugTaken: vi.fn(async (_ctx, slug) => options.existingSlugs?.includes(slug) ?? false),
    peekQuota: vi.fn(async (_ctx, meter: Meter): Promise<QuotaResult> => {
      const limit = limits[meter] ?? null;
      return {
        meter,
        period: "all",
        allowed: true,
        limit,
        used: 0,
        remaining: limit,
        warned: false,
      };
    }),
  };
  const count = (step: string) => calls.filter((call) => call.step === step).length;
  return { deps, calls, count, runs };
}

describe("listWorkspaceTemplates", () => {
  it("lists the ten businesses as gallery cards, without their blueprints", () => {
    const cards = listWorkspaceTemplates();
    expect(cards).toHaveLength(10);
    expect(cards[0]).toMatchObject({ id: "hotel", name: "Graft Hotel" });
    expect(cards[0]).not.toHaveProperty("entities");
  });
});

describe("previewWorkspaceTemplate", () => {
  it("prices the plan against what the tenant has left", async () => {
    const { deps } = harness();
    const preview = await previewWorkspaceTemplate(ctx, "hotel", {}, deps);
    expect(preview.requirements).toEqual({
      entities: 2,
      records: 3,
      internal_forms: 0,
      active_forms: 1,
    });
    expect(preview.fits).toBe(true);
  });

  it("marks a module that would overflow the plan as not fitting", async () => {
    const { deps } = harness();
    // Free: 3 entities. Core takes 2, so one module fits and the second does not.
    const preview = await previewWorkspaceTemplate(ctx, "hotel", { modules: ["guests"] }, deps);
    expect(preview.modules).toEqual([
      expect.objectContaining({ id: "guests", selected: true, fits: true }),
      expect.objectContaining({ id: "housekeeping", selected: false, fits: false }),
    ]);
  });

  it("treats an unlimited meter as always fitting", async () => {
    const { deps } = harness({ limits: { entities: null, internal_forms: null } });
    const preview = await previewWorkspaceTemplate(ctx, "hotel", {}, deps);
    expect(preview.modules.every((module) => module.fits)).toBe(true);
  });

  it("suffixes a key or slug the tenant already uses, and says so", async () => {
    const { deps } = harness({ existingKeys: ["rooms"], existingSlugs: ["book-a-room"] });
    const preview = await previewWorkspaceTemplate(ctx, "hotel", {}, deps);
    expect(preview.plan.entities[0]!.key).toBe("rooms_2");
    expect(preview.plan.forms[0]!.slug).toBe("book-a-room-2");
    expect(preview.renamed).toEqual([
      { kind: "entity", ref: "rooms", from: "rooms", to: "rooms_2" },
      { kind: "form", ref: "reservation", from: "book-a-room", to: "book-a-room-2" },
    ]);
  });

  it("reports a bad answer as a field error, like any other form", async () => {
    const { deps } = harness();
    await expect(
      previewWorkspaceTemplate(ctx, "hotel", { paymentLink: "https://evil.example" }, deps),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fields: { paymentLink: expect.stringContaining("Stripe") } },
    });
  });

  it("404s a template that does not exist", async () => {
    const { deps } = harness();
    await expect(previewWorkspaceTemplate(ctx, "castle", {}, deps)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("applyWorkspaceTemplate", () => {
  it("creates entities, records, pools and forms in order, and publishes", async () => {
    const { deps, calls, count } = harness();
    const result = await applyWorkspaceTemplate(
      ctx,
      "hotel",
      { answers: { depositPercent: 20 } },
      deps,
    );

    expect(count("createEntity")).toBe(2);
    expect(count("createRecord")).toBe(3);
    expect(count("createPool")).toBe(3);
    expect(count("createForm")).toBe(1);
    expect(count("publishForm")).toBe(1);
    const order = calls.map((call) => call.step);
    expect(order.indexOf("createForm")).toBeGreaterThan(order.lastIndexOf("createPool"));

    const [rooms, reservations] = result.entities;
    const form = calls.find((call) => call.step === "createForm")!.input as {
      entityId: string;
      catalogue: { entityId: string };
      booking: unknown;
    };
    expect(form.entityId).toBe(reservations!.id);
    expect(form.catalogue.entityId).toBe(rooms!.id);
    expect(form.booking).toMatchObject({ rateKey: "nightly_rate", depositPercent: 20 });

    expect(result).toMatchObject({ status: "completed", records: 3, pools: 3 });
    expect(result.forms[0]).toMatchObject({
      slug: "book-a-room",
      takesBookings: true,
      publicSlug: expect.stringMatching(/^acme\//),
    });
  });

  it("refuses before writing anything when the plan does not fit", async () => {
    const { deps, calls, runs } = harness({ limits: { entities: 1 } });
    await expect(applyWorkspaceTemplate(ctx, "hotel", {}, deps)).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
      details: { short: ["entities"] },
    });
    expect(calls).toEqual([]);
    expect(runs.docs).toEqual([]);
  });

  it("carries the run id on a failure, and resuming skips what was already made", async () => {
    const { deps, count } = harness({ failOn: { step: "createForm", times: 1 } });

    let runId: string | undefined;
    try {
      await applyWorkspaceTemplate(ctx, "hotel", {}, deps);
      expect.unreachable();
    } catch (error) {
      runId = ((error as AppError).details as { runId: string }).runId;
    }
    expect(runId).toMatch(/^[0-9a-f]{24}$/);
    expect(count("createEntity")).toBe(2);
    expect(count("createRecord")).toBe(3);

    const result = await applyWorkspaceTemplate(ctx, "hotel", { runId }, deps);
    expect(result.status).toBe("completed");
    // Nothing made twice: the resume only did the form and its publish.
    expect(count("createEntity")).toBe(2);
    expect(count("createRecord")).toBe(3);
    expect(count("createPool")).toBe(3);
    expect(count("createForm")).toBe(1);
    expect(count("publishForm")).toBe(1);
  });

  it("resumes with the run's own answers, not whatever is sent again", async () => {
    const { deps, calls } = harness({ failOn: { step: "createPool", times: 1 } });
    let runId = "";
    await applyWorkspaceTemplate(
      ctx,
      "hotel",
      { answers: { nouns: { room: { singular: "Cabin", plural: "Cabins" } } } },
      deps,
    ).catch((error: AppError) => {
      runId = (error.details as { runId: string }).runId;
    });
    await applyWorkspaceTemplate(ctx, "hotel", { runId, answers: {} }, deps);
    const form = calls.find((call) => call.step === "createForm")!.input as { slug: string };
    expect(form.slug).toBe("book-a-cabin");
  });

  it("returns a completed run as it is rather than applying it twice", async () => {
    const { deps, count } = harness();
    const first = await applyWorkspaceTemplate(ctx, "hotel", {}, deps);
    const again = await applyWorkspaceTemplate(ctx, "hotel", { runId: first.runId }, deps);
    expect(again).toEqual(first);
    expect(count("createEntity")).toBe(2);
  });

  it("uses the suffixed names it claimed, so it never collides with the tenant's own", async () => {
    const { deps, calls } = harness({ existingKeys: ["rooms"] });
    await applyWorkspaceTemplate(ctx, "hotel", {}, deps);
    const keys = calls
      .filter((call) => call.step === "createEntity")
      .map((call) => (call.input as { key: string }).key);
    expect(keys).toEqual(["rooms_2", "reservations"]);
  });

  it("builds an enquiry-only workspace with no pools and no booking", async () => {
    const { deps, calls, count } = harness();
    await applyWorkspaceTemplate(ctx, "trades", { answers: { publish: false } }, deps);
    expect(count("createPool")).toBe(0);
    expect(count("publishForm")).toBe(0);
    const form = calls.find((call) => call.step === "createForm")!.input as {
      booking: unknown;
    };
    expect(form.booking).toBeNull();
  });

  it("404s a run id from another template", async () => {
    const { deps } = harness();
    const run = await applyWorkspaceTemplate(ctx, "hotel", {}, deps);
    await expect(
      applyWorkspaceTemplate(ctx, "salon", { runId: run.runId }, deps),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
