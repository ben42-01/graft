/**
 * Guided setup runs — persistence only.
 *
 * Same division of labour as `onboarding.ts`: the flow is a client concern,
 * and every entity, record, pool and form a run produces is created through
 * the *ordinary* endpoints. This module only remembers which step a tenant
 * got to and what the run has produced so far, so closing the tab halfway
 * through and coming back resumes rather than restarts.
 *
 * Because nothing here ever creates an entity or a form itself, abandoning a
 * run cannot leave one half-created. What it leaves behind is a real entity
 * with real records in it — usable on its own, reachable from `/entities`,
 * and not marked as owned by a wizard.
 *
 * One *active* run per tenant. Starting a new one closes the previous one
 * rather than deleting it: the old run's entity and form still exist, and a
 * run doc that vanished would make "what did I do last Tuesday" unanswerable.
 * The shape of a run's state is `@/lib/setup/flow`, which both this module
 * and the page import so neither invents its own idea of what a step is.
 */
import type { ObjectId } from "mongodb";
import { z } from "zod";
import { SETUP_INTENTS, SETUP_STEPS, type SetupRunState } from "@/lib/setup/flow";
import type { Ctx } from "@/server/context";
import { parse } from "@/server/http/validate";
import { createRepository, type Repository } from "@/server/repositories/base";

export { SETUP_INTENTS, SETUP_STEPS } from "@/lib/setup/flow";
export type { SetupIntent, SetupRunState, SetupStepId } from "@/lib/setup/flow";

const objectIdHex = z.string().regex(/^[0-9a-f]{24}$/, "expected an id");

/**
 * What a client may change about a run. Every field is optional and merged,
 * so a step only ever sends what it just did — a PATCH from the records step
 * can never clear the intent chosen two steps earlier.
 *
 * Ids are validated as ids but deliberately *not* checked for existence: this
 * service does not own them, and a run pointing at an entity the user has
 * since deleted is a stale pointer to report, not a write to refuse. The page
 * re-reads the real objects on load and repairs the run from what it finds.
 */
export const patchSetupRunSchema = z
  .object({
    step: z.enum(SETUP_STEPS).optional(),
    thingLabel: z.string().trim().max(120).optional(),
    intent: z.enum(SETUP_INTENTS).nullable().optional(),
    resourceEntityId: objectIdHex.nullable().optional(),
    recordCount: z.number().int().min(0).optional(),
    bookableRecordCount: z.number().int().min(0).optional(),
    requestEntityId: objectIdHex.nullable().optional(),
    formId: objectIdHex.nullable().optional(),
    formPublished: z.boolean().optional(),
    /** Sent once, when the closing step is reached. */
    completed: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to update" });

export type PatchSetupRunInput = z.input<typeof patchSetupRunSchema>;

export type SetupRunDoc = SetupRunState & {
  tenantId: ObjectId;
  step: (typeof SETUP_STEPS)[number];
  /** Set when the run is finished, or when a newer run supersedes it. */
  closedAt: Date | null;
  completedAt: Date | null;
};

export type SetupRunView = SetupRunState & {
  id: string;
  step: (typeof SETUP_STEPS)[number];
  completedAt: Date | null;
};

export type SetupRunDeps = { repo: Repository<SetupRunDoc> };

const defaultRepo = createRepository<SetupRunDoc>("setup_runs");

function resolveDeps(overrides: Partial<SetupRunDeps> = {}): SetupRunDeps {
  return { repo: overrides.repo ?? defaultRepo };
}

const NEW_RUN: SetupRunState & { step: (typeof SETUP_STEPS)[number] } = {
  step: "thing",
  thingLabel: "",
  intent: null,
  resourceEntityId: null,
  recordCount: 0,
  bookableRecordCount: 0,
  requestEntityId: null,
  formId: null,
  formPublished: false,
};

function toView(doc: SetupRunDoc & { _id: ObjectId }): SetupRunView {
  return {
    id: doc._id.toHexString(),
    step: doc.step,
    thingLabel: doc.thingLabel,
    intent: doc.intent,
    resourceEntityId: doc.resourceEntityId,
    recordCount: doc.recordCount,
    bookableRecordCount: doc.bookableRecordCount,
    requestEntityId: doc.requestEntityId,
    formId: doc.formId,
    formPublished: doc.formPublished,
    completedAt: doc.completedAt,
  };
}

/**
 * The run in progress, or `null` when there is none. Unlike onboarding state,
 * absence is a real answer here rather than a default: a tenant who has never
 * opened the flow, and one who finished it last month, both have nothing
 * open, and the difference between "resume" and "start" is a decision the
 * page should make out loud.
 */
export async function getActiveSetupRun(
  ctx: Ctx,
  overrides: Partial<SetupRunDeps> = {},
): Promise<SetupRunView | null> {
  const deps = resolveDeps(overrides);
  const doc = await deps.repo.findOne(ctx, { closedAt: null });
  return doc ? toView(doc) : null;
}

/**
 * Starts a run, closing whatever was open. Nothing the previous run created
 * is touched — closing is about which run the page resumes, not about undoing
 * work that is already real and already in use.
 */
export async function startSetupRun(
  ctx: Ctx,
  overrides: Partial<SetupRunDeps> = {},
): Promise<SetupRunView> {
  const deps = resolveDeps(overrides);
  const open = await deps.repo.findOne(ctx, { closedAt: null });
  if (open) {
    await deps.repo.updateOne(ctx, { _id: open._id }, { $set: { closedAt: new Date() } });
  }
  const inserted = await deps.repo.insertOne(ctx, {
    ...NEW_RUN,
    closedAt: null,
    completedAt: null,
  } as Omit<SetupRunDoc, "tenantId">);
  return toView(inserted);
}

/**
 * Merges a step's outcome into the active run, starting one if none is open
 * (a PATCH from a page that was left sitting open past a completion should
 * carry on working rather than 404).
 *
 * `completed` stamps `completedAt` once and closes the run — a finished run
 * is not resumed, it is started again. As in `patchOnboardingState`, the
 * stamp is never rewritten: the first finish is the one that happened.
 */
export async function patchSetupRun(
  ctx: Ctx,
  input: unknown,
  overrides: Partial<SetupRunDeps> = {},
): Promise<SetupRunView> {
  const deps = resolveDeps(overrides);
  const { completed, ...patch } = parse(patchSetupRunSchema, input, "body");

  const open = (await deps.repo.findOne(ctx, { closedAt: null })) ?? null;
  const base = open ?? (await startAsDoc(ctx, deps));

  const now = new Date();
  const completedAt = base.completedAt ?? (completed ? now : null);
  const $set: Partial<SetupRunDoc> = {
    ...patch,
    completedAt,
    ...(completed ? { closedAt: base.closedAt ?? now } : {}),
  };

  const updated = await deps.repo.updateOne(ctx, { _id: base._id }, { $set });
  return toView(updated ?? { ...base, ...$set });
}

async function startAsDoc(ctx: Ctx, deps: SetupRunDeps) {
  return deps.repo.insertOne(ctx, {
    ...NEW_RUN,
    closedAt: null,
    completedAt: null,
  } as Omit<SetupRunDoc, "tenantId">);
}
