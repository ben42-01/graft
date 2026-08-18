/**
 * Onboarding wizard state — persistence only (GRAFT-12, docs/Graft.md §3).
 *
 * The wizard is entirely a client concern: every entity, form, plugin and
 * dashboard it creates goes through the *normal* GRAFT-06/08/14/13 service
 * functions (AC5) — this module only remembers which step a tenant is on and
 * what they've entered, so closing the browser mid-wizard and coming back
 * resumes at the same step with prior input intact (AC2). Because nothing
 * here ever writes an entity, form or dashboard itself, abandoning at any
 * step can never leave one half-created (AC7): the underlying create calls
 * this state merely remembers the outcome of are already all-or-nothing.
 *
 * One document per tenant. `data` is a shallow bag keyed by step name
 * (`{ profile: {...}, template: {...} }`), merged key-by-key on every PATCH
 * so answering a later step never clobbers an earlier one's answers.
 */
import type { ObjectId } from "mongodb";
import { z } from "zod";
import type { Ctx } from "@/server/context";
import { parse } from "@/server/http/validate";
import { createRepository, type Repository } from "@/server/repositories/base";
import { ONBOARDING_STEPS, type OnboardingStep } from "@/lib/onboarding-templates";

export {
  ONBOARDING_STEPS,
  type OnboardingStep,
  STARTER_TEMPLATES,
  BLANK_TEMPLATE,
  suggestTemplate,
  findTemplate,
  type StarterTemplate,
} from "@/lib/onboarding-templates";

export const patchOnboardingSchema = z
  .object({
    step: z.enum(ONBOARDING_STEPS).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => v.step !== undefined || v.data !== undefined, {
    message: "Nothing to update",
  });

export type PatchOnboardingInput = z.input<typeof patchOnboardingSchema>;

export type OnboardingStateDoc = {
  tenantId: ObjectId;
  step: OnboardingStep;
  data: Record<string, unknown>;
  completedAt: Date | null;
};

export type OnboardingStateView = {
  step: OnboardingStep;
  data: Record<string, unknown>;
  completedAt: Date | null;
};

const DEFAULT_STATE: OnboardingStateView = { step: "profile", data: {}, completedAt: null };

export type OnboardingDeps = { repo: Repository<OnboardingStateDoc> };

const defaultRepo = createRepository<OnboardingStateDoc>("onboarding_state");

function resolveDeps(overrides: Partial<OnboardingDeps> = {}): OnboardingDeps {
  return { repo: overrides.repo ?? defaultRepo };
}

function toView(
  doc: Pick<OnboardingStateDoc, "step" | "data" | "completedAt">,
): OnboardingStateView {
  return { step: doc.step, data: doc.data, completedAt: doc.completedAt };
}

/** AC2 — a tenant with no state yet reads as step "profile", data {} rather
 * than a 404: resuming and starting fresh are the same request. */
export async function getOnboardingState(
  ctx: Ctx,
  overrides: Partial<OnboardingDeps> = {},
): Promise<OnboardingStateView> {
  const deps = resolveDeps(overrides);
  const doc = await deps.repo.findOne(ctx);
  return doc ? toView(doc) : DEFAULT_STATE;
}

/** AC2, AC7 — `data` merges shallowly by step key so an earlier step's
 * answers are never lost to a later PATCH; `step` moves independently so the
 * wizard can also step back without discarding anything ahead of it.
 * `completedAt` is stamped once, the first time `step` reaches "done", and
 * never rewritten after. */
export async function patchOnboardingState(
  ctx: Ctx,
  input: unknown,
  overrides: Partial<OnboardingDeps> = {},
): Promise<OnboardingStateView> {
  const deps = resolveDeps(overrides);
  const parsed = parse(patchOnboardingSchema, input, "body");
  const existing = await deps.repo.findOne(ctx);

  const nextData = { ...(existing?.data ?? {}), ...(parsed.data ?? {}) };
  const nextStep = parsed.step ?? existing?.step ?? "profile";
  const completedAt = existing?.completedAt ?? (nextStep === "done" ? new Date() : null);

  if (existing) {
    const updated = await deps.repo.updateOne(
      ctx,
      {},
      { $set: { step: nextStep, data: nextData, completedAt } },
    );
    return toView(updated ?? { step: nextStep, data: nextData, completedAt });
  }

  const inserted = await deps.repo.insertOne(ctx, {
    step: nextStep,
    data: nextData,
    completedAt,
  });
  return toView(inserted);
}
