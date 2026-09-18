/**
 * Blueprint + answers → the concrete things to create.
 *
 * Pure and client-safe: the wizard calls it to draw the preview, and the
 * server calls the same function to decide what to write, so what the owner
 * was shown is exactly what gets built.
 *
 * The output still names entities by `ref` rather than id — ids only exist
 * once the server has created them — but every other value is final: keys
 * renamed, conditional fields dropped, booking basis and deposit chosen,
 * payment link and terms checked.
 */
import { isSafeLinkUrl, type ContentBlock } from "@/lib/content-blocks";
import { toIdentifier } from "@/lib/entities/field-types";
import { isPaymentLinkUrl, PAYMENT_LINK_HOST } from "@/lib/payment-links";
import {
  POOL_STRATEGIES,
  RATE_BASES,
  templateAnswersSchema,
  type Condition,
  type TemplateAnswers,
  type TemplateAnswersInput,
  type WorkspaceTemplate,
} from "./schema";

/** An answer the owner can fix, reported against the answer that caused it. */
export class TemplateAnswerError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "TemplateAnswerError";
  }
}

export type PlannedField = {
  key: string;
  label: string;
  type: string;
  required: boolean;
  options?: string[];
};

export type PlannedEntity = {
  ref: string;
  key: string;
  name: string;
  module: string | null;
  fields: PlannedField[];
};

export type PlannedPool = {
  strategy: (typeof POOL_STRATEGIES)[number];
  totalQuantity?: number;
  bufferMinutes?: number;
};

export type PlannedRecord = {
  /** Stable within a plan, so a resumed run can tell what it already made. */
  ref: string;
  entityRef: string;
  data: Record<string, string | number | boolean>;
  pool: PlannedPool | null;
};

export type PlannedBooking = {
  startKey: string;
  endKey: string | null;
  durationMinutes: number | null;
  quantityKey: string | null;
  rateBasis: (typeof RATE_BASES)[number];
  rateKey: string | null;
  labelKey: string | null;
  depositPercent: number | null;
};

export type PlannedForm = {
  ref: string;
  entityRef: string;
  name: string;
  slug: string;
  visibility: "internal" | "public";
  module: string | null;
  fields: string[];
  catalogue: {
    entityRef: string;
    fields: string[];
    imageField: string | null;
    selectionKey: string;
  } | null;
  booking: PlannedBooking | null;
  payment: { mode: "link"; link: { url: string }; required: boolean } | null;
  content: ContentBlock[];
  publish: boolean;
};

export type WorkspacePlan = {
  templateId: string;
  entities: PlannedEntity[];
  records: PlannedRecord[];
  forms: PlannedForm[];
};

/** What applying a plan will charge, in `meters.ts` vocabulary. */
export type PlanRequirements = {
  entities: number;
  records: number;
  internal_forms: number;
  active_forms: number;
};

export const REQUIREMENT_METERS = [
  "entities",
  "records",
  "internal_forms",
  "active_forms",
] as const satisfies readonly (keyof PlanRequirements)[];

/**
 * "Room" → "room" for mid-sentence use, but "MRI scanner" stays as typed:
 * lowercasing an acronym is worse than a capital in the middle of a sentence.
 */
function lower(text: string): string {
  return /[A-Z]{2}/.test(text) ? text : text.toLowerCase();
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

type Nouns = Map<string, { singular: string; plural: string }>;

/**
 * `{room}` → singular, `{room.plural}` → plural; a capital first letter in
 * the placeholder (`{Room}`, `{Room.plural}`) capitalises the result. An
 * unknown placeholder is left alone, which the template tests catch.
 */
export function fillNouns(text: string, nouns: Nouns): string {
  return text.replace(
    /\{([A-Za-z_]+)(\.plural)?\}/g,
    (match, name: string, plural?: string) => {
      const noun = nouns.get(name.toLowerCase());
      if (!noun) return match;
      const value = plural ? noun.plural : noun.singular;
      const upper = name.charAt(0) !== name.charAt(0).toLowerCase();
      return upper ? capital(value) : lower(value);
    },
  );
}

/** Form slugs are dash-separated (`formSlugSchema`), entity keys underscored. */
export function toFormSlug(text: string): string {
  return toIdentifier(text, 56).replace(/_/g, "-");
}

/**
 * Fills in defaults and refuses anything that does not belong to this
 * template, so a stale or hand-written answer fails loudly instead of being
 * silently ignored.
 */
export function normaliseAnswers(
  template: WorkspaceTemplate,
  input: TemplateAnswersInput = {},
): TemplateAnswers {
  const parsed = templateAnswersSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new TemplateAnswerError(
      String(issue?.path[0] ?? "answers"),
      issue?.message ?? "Invalid",
    );
  }
  const answers = parsed.data;

  const toggles: Record<string, boolean | string> = {};
  for (const toggle of template.toggles) toggles[toggle.id] = toggle.default;
  for (const [id, value] of Object.entries(answers.toggles)) {
    const toggle = template.toggles.find((candidate) => candidate.id === id);
    if (!toggle)
      throw new TemplateAnswerError("toggles", `"${id}" is not a choice on this template`);
    if (toggle.kind === "boolean" && typeof value !== "boolean") {
      throw new TemplateAnswerError("toggles", `"${toggle.label}" is a yes/no choice`);
    }
    if (toggle.kind === "choice" && !toggle.options.some((option) => option.value === value)) {
      throw new TemplateAnswerError(
        "toggles",
        `"${String(value)}" is not an option for "${toggle.label}"`,
      );
    }
    toggles[id] = value;
  }

  for (const id of answers.modules) {
    if (!template.modules.some((module) => module.id === id)) {
      throw new TemplateAnswerError("modules", `"${id}" is not a module on this template`);
    }
  }

  for (const id of Object.keys(answers.nouns)) {
    if (!template.nouns.some((noun) => noun.id === id)) {
      throw new TemplateAnswerError(
        "nouns",
        `"${id}" is not something this template lets you rename`,
      );
    }
  }

  for (const path of answers.omitFields) {
    const [entityRef, fieldKey] = path.split(".");
    const field = template.entities
      .find((entity) => entity.ref === entityRef)
      ?.fields.find((candidate) => candidate.key === fieldKey);
    if (!field)
      throw new TemplateAnswerError("omitFields", `"${path}" is not a field on this template`);
    if (!field.optional) {
      throw new TemplateAnswerError(
        "omitFields",
        `"${field.label}" is needed and cannot be left out`,
      );
    }
  }

  return { ...answers, toggles, modules: [...new Set(answers.modules)] };
}

export function resolveTemplate(
  template: WorkspaceTemplate,
  input: TemplateAnswersInput = {},
): WorkspacePlan {
  const answers = normaliseAnswers(template, input);
  const modules = new Set(answers.modules);

  const holds = (when: Condition[] | undefined): boolean =>
    (when ?? []).every(
      (condition) =>
        (condition.toggle === undefined ||
          answers.toggles[condition.toggle] === condition.equals) &&
        (condition.module === undefined || modules.has(condition.module)),
    );
  const inModule = (module: string | undefined) => module === undefined || modules.has(module);

  const nouns: Nouns = new Map(
    template.nouns.map((noun) => [noun.id, answers.nouns[noun.id] ?? noun]),
  );
  const fill = (text: string) => fillNouns(text, nouns);
  const omitted = new Set(answers.omitFields);

  // ── Entities ────────────────────────────────────────────────────────────
  const entities: PlannedEntity[] = [];
  for (const entity of template.entities) {
    if (!inModule(entity.module) || !holds(entity.when)) continue;
    const noun = entity.noun ? nouns.get(entity.noun) : undefined;
    const fields = entity.fields
      .filter((field) => holds(field.when) && !omitted.has(`${entity.ref}.${field.key}`))
      .map((field): PlannedField => ({
        key: field.key,
        label: fill(field.label),
        type: field.type,
        required: field.required,
        ...(field.options ? { options: field.options } : {}),
      }));
    entities.push({
      ref: entity.ref,
      key: (noun && toIdentifier(noun.plural, 56)) || entity.key,
      name: noun ? capital(noun.plural) : fill(entity.name),
      module: entity.module ?? null,
      fields,
    });
  }

  const entityByRef = new Map(entities.map((entity) => [entity.ref, entity]));
  const fieldKeys = (ref: string) =>
    new Set(entityByRef.get(ref)?.fields.map((field) => field.key) ?? []);

  // ── Sample records and their pools ──────────────────────────────────────
  const records: PlannedRecord[] = [];
  if (answers.sampleData) {
    template.samples.forEach((set, setIndex) => {
      if (!entityByRef.has(set.entityRef) || !holds(set.when)) return;
      const keys = fieldKeys(set.entityRef);
      const pool = set.pool && holds(set.pool.when) ? set.pool : null;
      set.records.forEach((record, recordIndex) => {
        const data: Record<string, string | number | boolean> = {};
        for (const [key, value] of Object.entries(record.data)) {
          if (keys.has(key)) data[key] = typeof value === "string" ? fill(value) : value;
        }
        records.push({
          // No dots: a run stores progress under `created.records.<ref>`.
          ref: `${set.entityRef}:${setIndex}:${recordIndex}`,
          entityRef: set.entityRef,
          data,
          pool: pool
            ? {
                strategy: pool.strategy,
                ...(pool.strategy === "individual_asset"
                  ? {}
                  : { totalQuantity: record.quantity ?? 1 }),
                ...(pool.bufferMinutes !== undefined
                  ? { bufferMinutes: pool.bufferMinutes }
                  : {}),
              }
            : null,
        });
      });
    });
  }

  // ── Forms ───────────────────────────────────────────────────────────────
  const payment = resolvePayment(answers);
  const termsUrl = resolveTermsUrl(answers);

  const forms: PlannedForm[] = [];
  for (const form of template.forms) {
    if (!inModule(form.module) || !holds(form.when) || !entityByRef.has(form.entityRef))
      continue;
    const keys = fieldKeys(form.entityRef);
    const fields = form.fields.filter((key) => keys.has(key));
    if (fields.length === 0) {
      throw new Error(`${template.id}: form "${form.ref}" has no fields left`);
    }

    const catalogue =
      form.catalogue && entityByRef.has(form.catalogue.entityRef)
        ? (() => {
            const catalogueKeys = fieldKeys(form.catalogue.entityRef);
            return {
              entityRef: form.catalogue.entityRef,
              fields: form.catalogue.fields.filter((key) => catalogueKeys.has(key)),
              imageField:
                form.catalogue.imageField && catalogueKeys.has(form.catalogue.imageField)
                  ? form.catalogue.imageField
                  : null,
              selectionKey: form.catalogue.selectionKey,
            };
          })()
        : null;

    let booking: PlannedBooking | null = null;
    if (form.booking && catalogue && holds(form.booking.when)) {
      const basis =
        typeof form.booking.rateBasis === "string"
          ? form.booking.rateBasis
          : answers.toggles[form.booking.rateBasis.toggle];
      if (!RATE_BASES.includes(basis as (typeof RATE_BASES)[number])) {
        throw new Error(`${template.id}: form "${form.ref}" has no usable rate basis`);
      }
      const catalogueKeys = fieldKeys(catalogue.entityRef);
      booking = {
        startKey: form.booking.startKey,
        endKey: form.booking.endKey,
        durationMinutes: durationOf(
          form.booking.durationMinutes,
          answers,
          template.id,
          form.ref,
        ),
        quantityKey:
          form.booking.quantityKey && keys.has(form.booking.quantityKey)
            ? form.booking.quantityKey
            : null,
        rateBasis: basis as (typeof RATE_BASES)[number],
        rateKey:
          form.booking.rateKey && catalogueKeys.has(form.booking.rateKey)
            ? form.booking.rateKey
            : null,
        labelKey:
          form.booking.labelKey && catalogueKeys.has(form.booking.labelKey)
            ? form.booking.labelKey
            : null,
        depositPercent: form.booking.deposit ? answers.depositPercent : null,
      };
    }

    const last = fields[fields.length - 1] ?? null;
    const placeAfter = (key: string | null) =>
      key !== null && fields.includes(key) ? key : null;
    const content: ContentBlock[] = form.notices
      .filter((notice) => holds(notice.when))
      .map((notice, index) => ({
        id: `n${index + 1}`,
        kind: "notice",
        title: fill(notice.title),
        body: fill(notice.body),
        after: placeAfter(notice.after),
      }));
    if (form.terms) {
      content.push({
        id: "policy",
        kind: "notice",
        title: fill(template.policy.title),
        body: fill(template.policy.body),
        after: last,
      });
      if (termsUrl) {
        content.push({
          id: "terms",
          kind: "link",
          // The public form reads "I agree to <label>", and a refusal "Please
          // agree to <label> before sending" — so a noun, not a sentence.
          label: `the ${lower(fill(template.policy.title))}`,
          url: termsUrl,
          requireAgreement: true,
          after: last,
        });
      }
    }

    forms.push({
      ref: form.ref,
      entityRef: form.entityRef,
      name: fill(form.name),
      slug: toFormSlug(fill(form.slug)) || form.ref.replace(/_/g, "-"),
      visibility: form.visibility,
      module: form.module ?? null,
      fields,
      catalogue,
      booking,
      payment: form.payment ? payment : null,
      content,
      publish: form.visibility === "public" && answers.publish,
    });
  }

  return { templateId: template.id, entities, records, forms };
}

/**
 * A fixed length, or a choice toggle whose option values end in the minutes
 * (`min_45`, `min_90`) — how "How long is an appointment?" becomes a booking.
 */
function durationOf(
  value: number | { toggle: string } | null,
  answers: TemplateAnswers,
  templateId: string,
  formRef: string,
): number | null {
  if (value === null || typeof value === "number") return value;
  const minutes = Number(/(\d+)$/.exec(String(answers.toggles[value.toggle]))?.[1]);
  if (!Number.isInteger(minutes) || minutes < 1) {
    throw new Error(`${templateId}: form "${formRef}" has no usable duration`);
  }
  return minutes;
}

function resolvePayment(answers: TemplateAnswers): PlannedForm["payment"] {
  if (!answers.paymentLink) return null;
  if (!isPaymentLinkUrl(answers.paymentLink)) {
    throw new TemplateAnswerError(
      "paymentLink",
      `Paste a Stripe payment link — it starts with https://${PAYMENT_LINK_HOST}/`,
    );
  }
  return {
    mode: "link",
    link: { url: answers.paymentLink },
    required: answers.paymentRequired,
  };
}

function resolveTermsUrl(answers: TemplateAnswers): string | null {
  if (!answers.termsUrl) return null;
  if (!isSafeLinkUrl(answers.termsUrl)) {
    throw new TemplateAnswerError(
      "termsUrl",
      "Give the full web address of your terms, starting with https://",
    );
  }
  return answers.termsUrl;
}

export function requirementsOf(
  plan: Pick<WorkspacePlan, "entities" | "records" | "forms">,
): PlanRequirements {
  return {
    entities: plan.entities.length,
    records: plan.records.length,
    internal_forms: plan.forms.filter((form) => form.visibility === "internal").length,
    active_forms: plan.forms.filter((form) => form.publish).length,
  };
}

/**
 * What each module adds on top of the answers as given — how the wizard
 * decides which modules still fit the plan's remaining allowance.
 */
export function moduleCosts(
  template: WorkspaceTemplate,
  input: TemplateAnswersInput = {},
): Record<string, PlanRequirements> {
  const answers = normaliseAnswers(template, input);
  const base = requirementsOf(resolveTemplate(template, { ...answers, modules: [] }));
  const costs: Record<string, PlanRequirements> = {};
  for (const option of template.modules) {
    const withModule = requirementsOf(
      resolveTemplate(template, { ...answers, modules: [option.id] }),
    );
    costs[option.id] = {
      entities: withModule.entities - base.entities,
      records: withModule.records - base.records,
      internal_forms: withModule.internal_forms - base.internal_forms,
      active_forms: withModule.active_forms - base.active_forms,
    };
  }
  return costs;
}
