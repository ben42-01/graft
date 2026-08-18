/**
 * Onboarding wizard state — unit coverage (GRAFT-12 Test Contract: "template
 * -> bundle mapping; step validation"). Persistence and tenant scoping over a
 * real MongoDB are proven by bruno/onboarding/state.bru, which does not need
 * this file to also fake a repository for the happy path — this file proves
 * the pure logic: what a PATCH accepts, and what an industry suggests.
 */
import { ObjectId, type WithId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import type { Repository } from "@/server/repositories/base";
import {
  BLANK_TEMPLATE,
  findTemplate,
  ONBOARDING_STEPS,
  patchOnboardingSchema,
  patchOnboardingState,
  STARTER_TEMPLATES,
  suggestTemplate,
  type OnboardingStateDoc,
} from "./onboarding";

const TENANT = "000000000000000000000001";
const USER = "00000000000000000000000b";

const ctx: Ctx = createContext({
  requestId: "req-onboarding",
  tenantId: TENANT,
  userId: USER,
  roles: ["owner"],
  tier: "free",
});

/** A minimal in-memory stand-in for the repository port — one row per tenant,
 * the same shape onboarding.ts assumes. */
function fakeRepo(seed?: WithId<OnboardingStateDoc>) {
  let doc: WithId<OnboardingStateDoc> | null = seed ?? null;
  const tenantId = new ObjectId(TENANT);

  const repo: Repository<OnboardingStateDoc> = {
    collectionName: "onboarding_state",
    collection: vi.fn() as unknown as Repository<OnboardingStateDoc>["collection"],
    async find() {
      return doc ? [doc] : [];
    },
    async findOne() {
      return doc;
    },
    async findById() {
      return doc;
    },
    async count() {
      return doc ? 1 : 0;
    },
    async insertOne(_ctx, next) {
      doc = { ...next, tenantId, _id: new ObjectId() } as unknown as WithId<OnboardingStateDoc>;
      return doc;
    },
    async updateOne(_ctx, _filter, update) {
      if (!doc) return null;
      const set = (update.$set ?? {}) as Partial<OnboardingStateDoc>;
      doc = { ...doc, ...set };
      return doc;
    },
    async softDelete() {
      return false;
    },
    async listPage() {
      return { items: doc ? [doc] : [], meta: { limit: 25, hasMore: false, cursor: null } };
    },
  };
  return { repo };
}

describe("patchOnboardingSchema — step validation", () => {
  it("accepts a known step with no data", () => {
    expect(patchOnboardingSchema.safeParse({ step: "template" }).success).toBe(true);
  });

  it("accepts data with no step", () => {
    expect(
      patchOnboardingSchema.safeParse({ data: { profile: { name: "Acme" } } }).success,
    ).toBe(true);
  });

  it("rejects a step that isn't in ONBOARDING_STEPS", () => {
    const result = patchOnboardingSchema.safeParse({ step: "not-a-real-step" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty body — nothing to update", () => {
    expect(patchOnboardingSchema.safeParse({}).success).toBe(false);
  });

  it("every wizard step from docs/Graft.md §3 is representable", () => {
    for (const step of ONBOARDING_STEPS) {
      expect(patchOnboardingSchema.safeParse({ step }).success).toBe(true);
    }
  });
});

describe("patchOnboardingState — persistence semantics", () => {
  it("AC2 — merges data across steps instead of overwriting the bag", async () => {
    const { repo } = fakeRepo();
    await patchOnboardingState(
      ctx,
      { step: "profile", data: { profile: { name: "Acme" } } },
      {
        repo,
      },
    );
    const result = await patchOnboardingState(
      ctx,
      { step: "template", data: { template: { templateId: "trades-services" } } },
      { repo },
    );
    expect(result.step).toBe("template");
    expect(result.data).toEqual({
      profile: { name: "Acme" },
      template: { templateId: "trades-services" },
    });
  });

  it('AC2 — reaching "done" stamps completedAt once and never rewrites it', async () => {
    const { repo } = fakeRepo();
    const first = await patchOnboardingState(ctx, { step: "done" }, { repo });
    expect(first.completedAt).not.toBeNull();
    const second = await patchOnboardingState(
      ctx,
      { data: { done: { revisited: true } } },
      { repo },
    );
    expect(second.completedAt).toEqual(first.completedAt);
  });
});

describe("template -> bundle mapping", () => {
  it("scope — exactly 3 industry templates, each with a distinct id", () => {
    expect(STARTER_TEMPLATES).toHaveLength(3);
    expect(new Set(STARTER_TEMPLATES.map((t) => t.id)).size).toBe(3);
  });

  it("AC3 — an industry with a template suggests that template's bundle", () => {
    const suggestion = suggestTemplate("trades");
    expect(suggestion?.id).toBe("trades-services");
    expect(suggestion?.pluginIds).toContain("scheduling");
  });

  it('AC3 — an unmapped industry ("Other") suggests nothing, same as "start blank"', () => {
    expect(suggestTemplate("something-nobody-picked")).toBeNull();
  });

  it("every template's guided entity uses a key none of its suggested plugins provisions", () => {
    // Guards against a future template colliding with a plugin's own
    // createEntity call (CONFLICT) when both run in the same onboarding.
    const PLUGIN_ENTITY_KEYS: Record<string, string> = {
      contacts: "contacts",
      forms: "inquiries",
      scheduling: "appointments",
    };
    for (const template of [...STARTER_TEMPLATES, BLANK_TEMPLATE]) {
      for (const pluginId of template.pluginIds) {
        expect(template.entity.key).not.toBe(PLUGIN_ENTITY_KEYS[pluginId]);
      }
    }
  });

  it('findTemplate("blank") and an unknown id both fall back to the blank template', () => {
    expect(findTemplate("blank").id).toBe("blank");
    expect(findTemplate("does-not-exist").id).toBe("blank");
  });

  it("AC3 — every template's form only references fields its own entity declares", () => {
    for (const template of [...STARTER_TEMPLATES, BLANK_TEMPLATE]) {
      const entityKeys = new Set(template.entity.fields.map((f) => f.key));
      for (const fieldKey of template.form.fields) {
        expect(entityKeys.has(fieldKey)).toBe(true);
      }
    }
  });
});
