/**
 * Validation for the template JSON files. Mirrors `createEntitySchema` and
 * `fieldDefSchema` (src/server/services/entities.ts) — a template that this
 * rejects is one the API would reject too, which is the whole point: the
 * failure belongs in the test run, not in a user's face.
 *
 * Imported only by `templates.test.ts`, so it never reaches a client bundle.
 */
import { z } from "zod";
import { FIELD_TYPE_OPTIONS } from "@/lib/entities/field-types";

const identifier = (max: number) =>
  z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, "lowercase letters, digits and underscores")
    .max(max);

const offeredType = z.enum(
  FIELD_TYPE_OPTIONS.map((option) => option.type) as [string, ...string[]],
);

export const templateFieldSchema = z
  .object({
    key: identifier(64),
    label: z.string().trim().min(1).max(120),
    type: offeredType,
    required: z.boolean(),
    options: z.array(z.string().trim().min(1).max(120)).min(1).max(50).optional(),
  })
  .strict()
  .refine((field) => field.type !== "select" || (field.options?.length ?? 0) > 0, {
    message: "A choice list needs at least one option",
    path: ["options"],
  })
  .refine((field) => field.type === "select" || field.options === undefined, {
    message: "Only a choice list may carry options",
    path: ["options"],
  });

export const entityTemplateSchema = z
  .object({
    id: identifier(64),
    name: z.string().trim().min(1).max(120),
    category: z.string().trim().min(1).max(60),
    description: z.string().trim().min(20).max(400),
    entity: z
      .object({
        key: identifier(64),
        name: z.string().trim().min(1).max(120),
        fields: z.array(templateFieldSchema).min(1).max(100),
      })
      .strict(),
  })
  .strict();
