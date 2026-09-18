/**
 * Applying a workspace template — "Graft Hotel", "Graft Salon", … — to a
 * tenant: every entity, sample record, inventory pool and form the template's
 * blueprint resolves to, created in dependency order through the *ordinary*
 * services, so every quota, validation and uniqueness rule that guards a
 * hand-built workspace guards this one too.
 *
 * Three things are deliberate about how:
 *
 *   - **The quota check happens before the first write.** Each create service
 *     reserves its own quota before writing, and reserved quota is never given
 *     back (meters.ts). A template that ran out of entities on its third one
 *     would leave two behind *and* have spent them, so the whole plan is
 *     priced against what the tenant has left first, and refused as one
 *     `QUOTA_EXCEEDED` if it does not fit.
 *   - **It is resumable, not transactional.** The create services write one
 *     document each, outside any session; making them session-aware would be
 *     a rewrite of the repository layer. Instead a `template_runs` row records
 *     every id as it is created, and applying again with that run's id skips
 *     everything already made. What a failure leaves behind is real, usable
 *     entities and forms — the same position `plugins.provision` is in.
 *   - **It never adopts something it did not create.** A tenant who already
 *     has a `rooms` entity gets `rooms_2`, not their own entity quietly wired
 *     into a booking form with fields it does not have.
 */
import type { ObjectId } from "mongodb";
import { z } from "zod";
import {
  findWorkspaceTemplate,
  moduleCosts,
  normaliseAnswers,
  REQUIREMENT_METERS,
  requirementsOf,
  resolveTemplate,
  summariseWorkspaceTemplate,
  TemplateAnswerError,
  WORKSPACE_TEMPLATES,
  type PlanRequirements,
  type TemplateAnswers,
  type WorkspacePlan,
  type WorkspaceTemplate,
  type WorkspaceTemplateSummary,
} from "@/lib/workspace-templates";
import type { Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import { createRepository, type Repository } from "@/server/repositories/base";
import {
  createEntity as createEntityDefault,
  getEntityByKey as getEntityByKeyDefault,
  type EntityView,
} from "./entities";
import {
  createForm as createFormDefault,
  publishForm as publishFormDefault,
  type FormDoc,
  type FormView,
} from "./forms";
import { createPool as createPoolDefault } from "./inventory";
import { peekQuota as peekQuotaDefault, type Meter, type QuotaResult } from "./meters";
import { createRecord as createRecordDefault } from "./records";

export const templateIdParamSchema = z.object({
  templateId: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "Not a template id"),
});

/** Answers are validated in depth by `normaliseAnswers`, against the template. */
export const previewBodySchema = z.object({ answers: z.unknown().optional() });

export const applyBodySchema = z.object({
  answers: z.unknown().optional(),
  /** Resume a run that failed part-way; its stored answers win. */
  runId: z
    .string()
    .regex(/^[0-9a-f]{24}$/i, "Expected a 24-character id")
    .optional(),
});

type Created = {
  entities: Record<string, string>;
  records: Record<string, string>;
  pools: Record<string, string>;
  forms: Record<string, string>;
  /** Form ref → its public slug, once published. */
  published: Record<string, string>;
};

export type TemplateRunDoc = {
  tenantId: ObjectId;
  templateId: string;
  answers: TemplateAnswers;
  /** Entity ref → the key it was given, after collision suffixing. */
  keys: Record<string, string>;
  /** Form ref → the slug it was given, after collision suffixing. */
  slugs: Record<string, string>;
  created: Created;
  status: "running" | "failed" | "completed";
  error: string | null;
  completedAt: Date | null;
  deletedAt: Date | null;
};

export type WorkspaceTemplateDeps = {
  runs: Repository<TemplateRunDoc>;
  createEntity: (ctx: Ctx, input: unknown) => Promise<Pick<EntityView, "id">>;
  getEntityByKey: (ctx: Ctx, key: string) => Promise<Pick<EntityView, "id"> | null>;
  createRecord: (ctx: Ctx, entityId: string, data: unknown) => Promise<{ id: string }>;
  createPool: (ctx: Ctx, input: unknown) => Promise<{ id: string }>;
  createForm: (ctx: Ctx, input: unknown) => Promise<Pick<FormView, "id">>;
  publishForm: (ctx: Ctx, formId: string) => Promise<Pick<FormView, "id" | "publicSlug">>;
  formSlugTaken: (ctx: Ctx, slug: string) => Promise<boolean>;
  peekQuota: (ctx: Ctx, meter: Meter) => Promise<QuotaResult>;
};

const defaultRuns = createRepository<TemplateRunDoc>("template_runs");
const defaultForms = createRepository<FormDoc>("forms");

function resolveDeps(overrides: Partial<WorkspaceTemplateDeps> = {}): WorkspaceTemplateDeps {
  return {
    runs: overrides.runs ?? defaultRuns,
    createEntity: overrides.createEntity ?? ((ctx, input) => createEntityDefault(ctx, input)),
    getEntityByKey: overrides.getEntityByKey ?? ((ctx, key) => getEntityByKeyDefault(ctx, key)),
    createRecord:
      overrides.createRecord ??
      ((ctx, entityId, data) => createRecordDefault(ctx, entityId, data)),
    createPool: overrides.createPool ?? ((ctx, input) => createPoolDefault(ctx, input)),
    createForm: overrides.createForm ?? ((ctx, input) => createFormDefault(ctx, input)),
    publishForm: overrides.publishForm ?? ((ctx, formId) => publishFormDefault(ctx, formId)),
    formSlugTaken:
      overrides.formSlugTaken ??
      (async (ctx, slug) => (await defaultForms.findOne(ctx, { slug })) !== null),
    peekQuota: overrides.peekQuota ?? ((ctx, meter) => peekQuotaDefault(ctx, meter)),
  };
}

function templateOrThrow(templateId: string): WorkspaceTemplate {
  const template = findWorkspaceTemplate(templateId);
  if (!template) throw new AppError("NOT_FOUND", "Template not found");
  return template;
}

/** An answer the owner can fix, as the 400 every other form in the app returns. */
function resolveOrThrow(template: WorkspaceTemplate, answers: unknown) {
  try {
    const normalised = normaliseAnswers(template, (answers ?? {}) as object);
    return { answers: normalised, plan: resolveTemplate(template, normalised) };
  } catch (error) {
    if (error instanceof TemplateAnswerError) {
      throw new AppError("VALIDATION_FAILED", "Invalid request body", {
        source: "body",
        fields: { [error.field]: error.message },
      });
    }
    throw error;
  }
}

export function listWorkspaceTemplates(): WorkspaceTemplateSummary[] {
  return WORKSPACE_TEMPLATES.map(summariseWorkspaceTemplate);
}

export function getWorkspaceTemplate(templateId: string): WorkspaceTemplate {
  return templateOrThrow(templateId);
}

/** Per meter: `null` remaining is unlimited; a read-only (frozen) meter has none. */
type Allowance = Record<keyof PlanRequirements, number | null>;

async function allowanceFor(ctx: Ctx, deps: WorkspaceTemplateDeps): Promise<Allowance> {
  const results = await Promise.all(
    REQUIREMENT_METERS.map((meter) => deps.peekQuota(ctx, meter)),
  );
  return Object.fromEntries(
    results.map((result, index) => [
      REQUIREMENT_METERS[index],
      result.reason === "read_only" ? 0 : result.remaining,
    ]),
  ) as Allowance;
}

const fitsWithin = (needed: PlanRequirements, allowance: Allowance): boolean =>
  REQUIREMENT_METERS.every((meter) => {
    const remaining = allowance[meter];
    return remaining === null || needed[meter] <= remaining;
  });

const addRequirements = (a: PlanRequirements, b: PlanRequirements): PlanRequirements => ({
  entities: a.entities + b.entities,
  records: a.records + b.records,
  internal_forms: a.internal_forms + b.internal_forms,
  active_forms: a.active_forms + b.active_forms,
});

/** Enough to get past any realistic pile-up of earlier attempts; past it, something is wrong. */
const MAX_SUFFIX = 20;

/**
 * Keys and slugs this plan can have, suffixing any a live entity or form
 * already holds. Nothing of the tenant's is ever reused — see the module docs.
 */
async function claimNames(
  ctx: Ctx,
  plan: WorkspacePlan,
  deps: WorkspaceTemplateDeps,
): Promise<{ keys: Record<string, string>; slugs: Record<string, string> }> {
  const keys: Record<string, string> = {};
  for (const entity of plan.entities) {
    keys[entity.ref] = await firstFree(entity.key, "_", async (key) =>
      Object.values(keys).includes(key) ? true : (await deps.getEntityByKey(ctx, key)) !== null,
    );
  }
  const slugs: Record<string, string> = {};
  for (const form of plan.forms) {
    slugs[form.ref] = await firstFree(form.slug, "-", async (slug) =>
      Object.values(slugs).includes(slug) ? true : deps.formSlugTaken(ctx, slug),
    );
  }
  return { keys, slugs };
}

async function firstFree(
  base: string,
  separator: string,
  taken: (candidate: string) => Promise<boolean>,
): Promise<string> {
  if (!(await taken(base))) return base;
  for (let n = 2; n <= MAX_SUFFIX; n++) {
    const candidate = `${base.slice(0, 56)}${separator}${n}`;
    if (!(await taken(candidate))) return candidate;
  }
  throw new AppError("CONFLICT", `"${base}" and its numbered alternatives are all in use`);
}

export type PreviewView = {
  template: WorkspaceTemplateSummary;
  plan: WorkspacePlan;
  requirements: PlanRequirements;
  allowance: Allowance;
  fits: boolean;
  modules: {
    id: string;
    name: string;
    selected: boolean;
    cost: PlanRequirements;
    fits: boolean;
  }[];
  renamed: { kind: "entity" | "form"; ref: string; from: string; to: string }[];
};

/** The plan with the names it would actually get — what the wizard's preview draws. */
function withNames(
  plan: WorkspacePlan,
  names: { keys: Record<string, string>; slugs: Record<string, string> },
): WorkspacePlan {
  return {
    ...plan,
    entities: plan.entities.map((entity) => ({
      ...entity,
      key: names.keys[entity.ref] ?? entity.key,
    })),
    forms: plan.forms.map((form) => ({ ...form, slug: names.slugs[form.ref] ?? form.slug })),
  };
}

export async function previewWorkspaceTemplate(
  ctx: Ctx,
  templateId: string,
  answersInput: unknown,
  overrides: Partial<WorkspaceTemplateDeps> = {},
): Promise<PreviewView> {
  const deps = resolveDeps(overrides);
  const template = templateOrThrow(templateId);
  const { answers, plan } = resolveOrThrow(template, answersInput);

  const [allowance, names] = await Promise.all([
    allowanceFor(ctx, deps),
    claimNames(ctx, plan, deps),
  ]);
  const requirements = requirementsOf(plan);
  const costs = moduleCosts(template, answers);
  const selected = new Set(answers.modules);

  return {
    template: summariseWorkspaceTemplate(template),
    plan: withNames(plan, names),
    requirements,
    allowance,
    fits: fitsWithin(requirements, allowance),
    modules: template.modules.map((module) => ({
      id: module.id,
      name: module.name,
      selected: selected.has(module.id),
      cost: costs[module.id]!,
      // A chosen module already counts in `requirements`; an unchosen one
      // fits if it could be added on top of everything chosen so far.
      fits: selected.has(module.id)
        ? fitsWithin(requirements, allowance)
        : fitsWithin(addRequirements(requirements, costs[module.id]!), allowance),
    })),
    renamed: [
      ...plan.entities
        .filter((entity) => names.keys[entity.ref] !== entity.key)
        .map((entity) => ({
          kind: "entity" as const,
          ref: entity.ref,
          from: entity.key,
          to: names.keys[entity.ref]!,
        })),
      ...plan.forms
        .filter((form) => names.slugs[form.ref] !== form.slug)
        .map((form) => ({
          kind: "form" as const,
          ref: form.ref,
          from: form.slug,
          to: names.slugs[form.ref]!,
        })),
    ],
  };
}

export type ApplyView = {
  runId: string;
  templateId: string;
  status: TemplateRunDoc["status"];
  entities: { ref: string; id: string; key: string; name: string }[];
  forms: {
    ref: string;
    id: string;
    name: string;
    slug: string;
    visibility: "internal" | "public";
    publicSlug: string | null;
    takesBookings: boolean;
  }[];
  records: number;
  pools: number;
};

/** What is still to do in a run — the part a resumed apply must still pay for. */
function remainingRequirements(plan: WorkspacePlan, created: Created): PlanRequirements {
  return {
    entities: plan.entities.filter((entity) => !created.entities[entity.ref]).length,
    records: plan.records.filter((record) => !created.records[record.ref]).length,
    internal_forms: plan.forms.filter(
      (form) => form.visibility === "internal" && !created.forms[form.ref],
    ).length,
    active_forms: plan.forms.filter((form) => form.publish && !created.published[form.ref])
      .length,
  };
}

function refuseQuota(needed: PlanRequirements, allowance: Allowance): never {
  const short = REQUIREMENT_METERS.filter((meter) => {
    const remaining = allowance[meter];
    return remaining !== null && needed[meter] > remaining;
  });
  throw new AppError(
    "QUOTA_EXCEEDED",
    "This setup needs more than your plan has left. Leave out some extras, or upgrade to continue.",
    { needed, allowance, short },
  );
}

export async function applyWorkspaceTemplate(
  ctx: Ctx,
  templateId: string,
  body: z.infer<typeof applyBodySchema>,
  overrides: Partial<WorkspaceTemplateDeps> = {},
): Promise<ApplyView> {
  const deps = resolveDeps(overrides);
  const template = templateOrThrow(templateId);

  let run: TemplateRunDoc & { _id: ObjectId };
  let plan: WorkspacePlan;

  if (body.runId) {
    const existing = await deps.runs.findById(ctx, body.runId);
    if (!existing || existing.templateId !== template.id) {
      throw new AppError("NOT_FOUND", "Setup run not found");
    }
    run = existing;
    plan = resolveOrThrow(template, run.answers).plan;
    if (run.status === "completed") return toApplyView(run, plan);

    const needed = remainingRequirements(plan, run.created);
    const allowance = await allowanceFor(ctx, deps);
    if (!fitsWithin(needed, allowance)) refuseQuota(needed, allowance);
  } else {
    const resolved = resolveOrThrow(template, body.answers);
    plan = resolved.plan;

    // Priced before the run exists, so a refusal leaves nothing behind at all.
    const needed = requirementsOf(plan);
    const allowance = await allowanceFor(ctx, deps);
    if (!fitsWithin(needed, allowance)) refuseQuota(needed, allowance);

    const names = await claimNames(ctx, plan, deps);
    run = await deps.runs.insertOne(ctx, {
      templateId: template.id,
      answers: resolved.answers,
      keys: names.keys,
      slugs: names.slugs,
      created: { entities: {}, records: {}, pools: {}, forms: {}, published: {} },
      status: "running",
      error: null,
      completedAt: null,
      deletedAt: null,
    });
  }

  const created: Created = structuredClone(run.created);
  const save = () => deps.runs.updateOne(ctx, { _id: run._id }, { $set: { created } });

  try {
    for (const entity of plan.entities) {
      if (created.entities[entity.ref]) continue;
      const view = await deps.createEntity(ctx, {
        key: run.keys[entity.ref] ?? entity.key,
        name: entity.name,
        fields: entity.fields,
      });
      created.entities[entity.ref] = view.id;
      await save();
    }

    for (const record of plan.records) {
      const entityId = created.entities[record.entityRef]!;
      if (!created.records[record.ref]) {
        const view = await deps.createRecord(ctx, entityId, record.data);
        created.records[record.ref] = view.id;
        await save();
      }
      if (record.pool && !created.pools[record.ref]) {
        const pool = await deps.createPool(ctx, {
          entityId,
          recordId: created.records[record.ref],
          ...record.pool,
        });
        created.pools[record.ref] = pool.id;
        await save();
      }
    }

    for (const form of plan.forms) {
      if (!created.forms[form.ref]) {
        const view = await deps.createForm(ctx, {
          entityId: created.entities[form.entityRef],
          name: form.name,
          slug: run.slugs[form.ref] ?? form.slug,
          visibility: form.visibility,
          fields: form.fields.map((key) => ({ key })),
          catalogue: form.catalogue
            ? {
                entityId: created.entities[form.catalogue.entityRef],
                fields: form.catalogue.fields,
                imageField: form.catalogue.imageField,
                selectionKey: form.catalogue.selectionKey,
              }
            : null,
          booking: form.booking,
          payment: form.payment,
          content: form.content,
        });
        created.forms[form.ref] = view.id;
        await save();
      }
      if (form.publish && !created.published[form.ref]) {
        const published = await deps.publishForm(ctx, created.forms[form.ref]!);
        created.published[form.ref] = published.publicSlug ?? "";
        await save();
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await deps.runs.updateOne(
      ctx,
      { _id: run._id },
      {
        $set: { created, status: "failed", error: message },
      },
    );
    // The run id travels with the error, so "Try again" resumes rather than
    // starting over and suffixing everything a second time.
    if (error instanceof AppError) {
      const details =
        typeof error.details === "object" && error.details !== null ? error.details : {};
      throw new AppError(error.code, error.message, {
        ...details,
        runId: run._id.toHexString(),
      });
    }
    throw error;
  }

  const completed = await deps.runs.updateOne(
    ctx,
    { _id: run._id },
    {
      $set: { created, status: "completed", error: null, completedAt: new Date() },
    },
  );
  return toApplyView(completed ?? { ...run, created, status: "completed" }, plan);
}

function toApplyView(run: TemplateRunDoc & { _id: ObjectId }, plan: WorkspacePlan): ApplyView {
  return {
    runId: run._id.toHexString(),
    templateId: run.templateId,
    status: run.status,
    entities: plan.entities
      .filter((entity) => run.created.entities[entity.ref])
      .map((entity) => ({
        ref: entity.ref,
        id: run.created.entities[entity.ref]!,
        key: run.keys[entity.ref] ?? entity.key,
        name: entity.name,
      })),
    forms: plan.forms
      .filter((form) => run.created.forms[form.ref])
      .map((form) => ({
        ref: form.ref,
        id: run.created.forms[form.ref]!,
        name: form.name,
        slug: run.slugs[form.ref] ?? form.slug,
        visibility: form.visibility,
        publicSlug: run.created.published[form.ref] || null,
        takesBookings: form.booking !== null,
      })),
    records: Object.keys(run.created.records).length,
    pools: Object.keys(run.created.pools).length,
  };
}
