/**
 * The shape of a workspace template ("Graft Hotel", "Graft Salon", …) and of
 * the answers an owner gives before applying one.
 *
 * A workspace template is a *blueprint*, not a set of API payloads: it names
 * its entities by `ref`, not by id, and leaves the decisions a business owner
 * actually has an opinion about — "can customers book?", "take a deposit?",
 * "what do you call your rooms?" — to toggles, modules and nouns. `resolve.ts`
 * turns a blueprint plus answers into concrete create inputs; the server then
 * creates them through the ordinary services.
 *
 * Pure Zod, no server imports — the wizard validates answers with the same
 * schema the apply endpoint does.
 */
import { z } from "zod";
import { FIELD_TYPE_OPTIONS } from "@/lib/entities/field-types";

const identifier = (max: number) =>
  z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, "lowercase letters, digits and underscores")
    .max(max);

const ref = identifier(40);

const offeredType = z.enum(
  FIELD_TYPE_OPTIONS.map((option) => option.type) as [string, ...string[]],
);

export const RATE_BASES = ["hourly", "daily", "flat"] as const;
export const POOL_STRATEGIES = ["individual_asset", "pooled_quantity", "time_slot"] as const;

/**
 * A condition on the owner's answers. Every clause must hold. `toggle` names a
 * toggle and `equals` its value; `module` holds when that module is chosen.
 */
const conditionSchema = z
  .object({
    toggle: ref.optional(),
    equals: z.union([z.boolean(), z.string()]).optional(),
    module: ref.optional(),
  })
  .strict()
  .refine((c) => c.toggle !== undefined || c.module !== undefined, {
    message: "A condition names a toggle or a module",
  })
  .refine((c) => (c.toggle === undefined) === (c.equals === undefined), {
    message: "A toggle condition needs a value to equal",
  });

const whenSchema = z.array(conditionSchema).min(1).optional();

export type Condition = z.infer<typeof conditionSchema>;

const nounSchema = z
  .object({
    id: ref,
    singular: z.string().trim().min(1).max(40),
    plural: z.string().trim().min(1).max(40),
    /** Shown in the rename step: "What do you call your rooms?" */
    question: z.string().trim().min(1).max(120),
  })
  .strict();

const toggleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: ref,
      kind: z.literal("boolean"),
      label: z.string().trim().min(1).max(120),
      help: z.string().trim().max(300).default(""),
      default: z.boolean(),
    })
    .strict(),
  z
    .object({
      id: ref,
      kind: z.literal("choice"),
      label: z.string().trim().min(1).max(120),
      help: z.string().trim().max(300).default(""),
      options: z
        .array(
          z
            .object({
              value: identifier(40),
              label: z.string().trim().min(1).max(120),
            })
            .strict(),
        )
        .min(2)
        .max(6),
      default: identifier(40),
    })
    .strict(),
]);

export type TemplateToggle = z.infer<typeof toggleSchema>;

const moduleSchema = z
  .object({
    id: ref,
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(300),
  })
  .strict();

/**
 * A field as the entities API takes it, plus two template-only switches:
 * `optional` lets the owner untick it in the wizard, `when` drops it unless
 * the answers match. Labels may use noun placeholders ("{Resource} name").
 */
const blueprintFieldSchema = z
  .object({
    key: identifier(64),
    label: z.string().trim().min(1).max(120),
    type: offeredType,
    required: z.boolean().default(false),
    options: z.array(z.string().trim().min(1).max(120)).min(1).max(50).optional(),
    optional: z.boolean().default(false),
    when: whenSchema,
  })
  .strict()
  .refine((f) => f.type !== "select" || (f.options?.length ?? 0) > 0, {
    message: "A choice list needs at least one option",
  })
  .refine((f) => f.type === "select" || f.options === undefined, {
    message: "Only a choice list may carry options",
  })
  .refine((f) => f.type !== "image" || !f.required, {
    message: "A picture cannot be required — it is uploaded after the record is created",
  });

export type BlueprintField = z.infer<typeof blueprintFieldSchema>;

const blueprintEntitySchema = z
  .object({
    ref,
    /** Used as-is unless `noun` is set, in which case it follows the rename. */
    key: identifier(56),
    name: z.string().trim().min(1).max(120),
    /** The entity *is* this noun: renaming "Rooms" to "Cabins" renames it. */
    noun: ref.optional(),
    module: ref.optional(),
    when: whenSchema,
    fields: z.array(blueprintFieldSchema).min(1).max(100),
  })
  .strict();

export type BlueprintEntity = z.infer<typeof blueprintEntitySchema>;

const sampleSetSchema = z
  .object({
    entityRef: ref,
    when: whenSchema,
    /** Makes every record in this set bookable. Absent: plain records. */
    pool: z
      .object({
        strategy: z.enum(POOL_STRATEGIES),
        bufferMinutes: z
          .number()
          .int()
          .min(0)
          .max(7 * 24 * 60)
          .optional(),
        when: whenSchema,
      })
      .strict()
      .optional(),
    records: z
      .array(
        z
          .object({
            data: z.record(z.union([z.string(), z.number(), z.boolean()])),
            /** Pool capacity for this record; ignored for `individual_asset`. */
            quantity: z.number().int().positive().max(100_000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();

const bookingBlueprintSchema = z
  .object({
    when: whenSchema,
    startKey: identifier(64),
    endKey: identifier(64).nullable().default(null),
    /** Minutes, or `{ toggle }` naming a choice toggle whose values end in minutes. */
    durationMinutes: z
      .union([
        z
          .number()
          .int()
          .min(1)
          .max(366 * 24 * 60),
        z.object({ toggle: ref }).strict(),
      ])
      .nullable()
      .default(null),
    quantityKey: identifier(64).nullable().default(null),
    /** A basis, or `{ toggle }` naming a choice toggle whose values are bases. */
    rateBasis: z.union([z.enum(RATE_BASES), z.object({ toggle: ref }).strict()]),
    rateKey: identifier(64).nullable().default(null),
    labelKey: identifier(64).nullable().default(null),
    /** True: the owner's deposit answer applies to this form. */
    deposit: z.boolean().default(false),
  })
  .strict()
  .refine((b) => (b.endKey === null) !== (b.durationMinutes === null), {
    message: "Give either an end-date field or a fixed duration, not both",
  });

const noticeSchema = z
  .object({
    title: z.string().trim().max(120).default(""),
    body: z.string().trim().min(1).max(2_000),
    after: identifier(64).nullable().default(null),
    when: whenSchema,
  })
  .strict();

const blueprintFormSchema = z
  .object({
    ref,
    entityRef: ref,
    name: z.string().trim().min(1).max(120),
    /** Noun placeholders allowed; slugified after filling. */
    slug: z.string().trim().min(1).max(56),
    visibility: z.enum(["internal", "public"]),
    module: ref.optional(),
    when: whenSchema,
    fields: z.array(identifier(64)).min(1).max(100),
    catalogue: z
      .object({
        entityRef: ref,
        fields: z.array(identifier(64)).max(6),
        imageField: identifier(64).nullable().default(null),
        selectionKey: identifier(64),
      })
      .strict()
      .optional(),
    booking: bookingBlueprintSchema.optional(),
    /** True: the owner's payment link (if they gave one) is attached here. */
    payment: z.boolean().default(false),
    /** True: the owner's terms (policy notice, agreement link) appear here. */
    terms: z.boolean().default(false),
    notices: z.array(noticeSchema).max(5).default([]),
  })
  .strict();

export type BlueprintForm = z.infer<typeof blueprintFormSchema>;

export const workspaceTemplateSchema = z
  .object({
    id: identifier(40),
    name: z.string().trim().min(1).max(60),
    tagline: z.string().trim().min(1).max(120),
    description: z.string().trim().min(20).max(600),
    icon: z.string().min(1).max(8),
    industry: z.string().trim().min(1).max(60),
    /** One line each: what the owner gets, for the gallery card. */
    highlights: z.array(z.string().trim().min(1).max(120)).min(2).max(6),
    nouns: z.array(nounSchema).max(4).default([]),
    toggles: z.array(toggleSchema).max(8).default([]),
    modules: z.array(moduleSchema).max(4).default([]),
    /** The notice shown when the owner turns terms on. Noun placeholders allowed. */
    policy: z
      .object({
        title: z.string().trim().min(1).max(120),
        body: z.string().trim().min(1).max(2_000),
      })
      .strict(),
    entities: z.array(blueprintEntitySchema).min(1).max(8),
    samples: z.array(sampleSetSchema).max(8).default([]),
    forms: z.array(blueprintFormSchema).min(1).max(6),
  })
  .strict();

export type WorkspaceTemplate = z.infer<typeof workspaceTemplateSchema>;
export type WorkspaceTemplateInput = z.input<typeof workspaceTemplateSchema>;

/**
 * What the owner decided in the wizard. Everything has a default, so `{}` is
 * a valid answer — it applies the template exactly as designed.
 */
export const templateAnswersSchema = z
  .object({
    toggles: z.record(z.union([z.boolean(), z.string().max(40)])).default({}),
    modules: z.array(ref).max(4).default([]),
    nouns: z
      .record(
        z
          .object({
            singular: z.string().trim().min(1).max(40),
            plural: z.string().trim().min(1).max(40),
          })
          .strict(),
      )
      .default({}),
    /** `"<entityRef>.<fieldKey>"` for each optional field the owner unticked. */
    omitFields: z.array(z.string().max(120)).max(100).default([]),
    depositPercent: z.number().int().min(1).max(100).nullable().default(null),
    paymentLink: z.string().trim().max(2_048).nullable().default(null),
    paymentRequired: z.boolean().default(false),
    termsUrl: z.string().trim().max(2_048).nullable().default(null),
    sampleData: z.boolean().default(true),
    publish: z.boolean().default(true),
  })
  .strict();

export type TemplateAnswers = z.infer<typeof templateAnswersSchema>;
export type TemplateAnswersInput = z.input<typeof templateAnswersSchema>;
