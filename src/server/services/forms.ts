/**
 * Form Builder — form definitions, publishing and slugs (GRAFT-08,
 * docs/Graft.md §4.4, docs/BACKEND.md §1, §2, docs/TIERS.md §2.2).
 *
 * A form is a named, ordered subset of an entity's fields plus a visibility
 * (`internal` or `public`) and a publish state. Three things matter enough to
 * call out:
 *
 *   - **A form cannot invent a field its entity lacks.** `fields` on create/
 *     update names entity field *keys*; the service copies the matching
 *     `FieldDef` across rather than trusting whatever the client sent, so a
 *     form's field list is always a real subset of its entity's (AC1).
 *   - **Quota is charged on the action that makes a form "active", not on
 *     creation.** A public form costs nothing to draft; it reserves
 *     `active_forms` quota only when published (AC4's "publishing a 3rd
 *     form"). An internal form has no publish step, so it reserves
 *     `internal_forms` quota at creation instead. Neither meter is freed on
 *     unpublish/delete — the same lifetime-counter convention `entities` and
 *     `records` already use (src/server/services/entities.ts,
 *     src/server/services/records.ts).
 *   - **The kill switch outranks `published`.** `enabled` is a separate flag
 *     from `published`, and whether a form may actually be served is the
 *     conjunction of both (`isFormServable`) — a killed form stays killed
 *     even if it is still marked published (AC5).
 */
import { MongoServerError, ObjectId, type Filter } from "mongodb";
import { z } from "zod";
import type { Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import { clampLimit } from "@/server/http/pagination";
import { parse } from "@/server/http/validate";
import { createLogger } from "@/server/log";
import { mongoAccountStore, type AccountStore } from "@/server/auth/accounts-store";
import { getEntity as getEntityDefault, type EntityView, type FieldDef } from "./entities";
import { consumeQuota as consumeQuotaDefault, type Meter, type QuotaResult } from "./meters";
import { createRepository, type Repository } from "@/server/repositories/base";

const objectIdHex = z.string().regex(/^[0-9a-f]{24}$/i, "Expected a 24-character id");

/** Same alphabet entity field keys use — never `$`, never `.` (entities.ts). */
const fieldKey = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "Use lowercase letters, digits and underscores, starting with a letter",
  );

/**
 * The user-influenced half of a public URL — validated strictly (Constraints:
 * "reject anything that could collide with an app route"). Single dashes only,
 * no leading/trailing dash, lowercase.
 */
export const formSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, digits and single dashes");

export const VISIBILITIES = ["internal", "public"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

const formFieldRefSchema = z.object({ key: fieldKey });

export const createFormSchema = z.object({
  entityId: objectIdHex,
  name: z.string().trim().min(1).max(120),
  slug: formSlugSchema,
  visibility: z.enum(VISIBILITIES),
  fields: z.array(formFieldRefSchema).min(1).max(100),
});

export const updateFormSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    fields: z.array(formFieldRefSchema).min(1).max(100).optional(),
    /** The kill switch (AC5). Independent of `published`. */
    enabled: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.fields !== undefined || v.enabled !== undefined, {
    message: "Nothing to update",
  });

export const listFormsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.union([z.string(), z.number()]).optional(),
});

export const formIdParamSchema = z.object({ formId: objectIdHex });

export type CreateFormInput = z.input<typeof createFormSchema>;
export type UpdateFormInput = z.input<typeof updateFormSchema>;

export type FormDoc = {
  tenantId: ObjectId;
  entityDefId: ObjectId;
  name: string;
  slug: string;
  /** Set only while published; globally unique (`{tenantSlug}/{slug}`). */
  publicSlug: string | null;
  visibility: Visibility;
  published: boolean;
  /** The kill switch (AC5) — independent of `published`. */
  enabled: boolean;
  killSwitchAt: Date | null;
  killSwitchBy: ObjectId | null;
  fields: FieldDef[];
  /** Constraints — Free retains this; read by GRAFT-10. */
  showBadge: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type FormView = {
  id: string;
  entityId: string;
  name: string;
  slug: string;
  publicSlug: string | null;
  visibility: Visibility;
  published: boolean;
  enabled: boolean;
  killSwitchAt: Date | null;
  killSwitchBy: string | null;
  fields: FieldDef[];
  showBadge: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const isDuplicateKey = (error: unknown): boolean =>
  error instanceof MongoServerError && error.code === 11000;

function toView(doc: { _id: ObjectId } & FormDoc): FormView {
  return {
    id: doc._id.toHexString(),
    entityId: doc.entityDefId.toHexString(),
    name: doc.name,
    slug: doc.slug,
    publicSlug: doc.publicSlug,
    visibility: doc.visibility,
    published: doc.published,
    enabled: doc.enabled,
    killSwitchAt: doc.killSwitchAt,
    killSwitchBy: doc.killSwitchBy ? doc.killSwitchBy.toHexString() : null,
    fields: doc.fields,
    showBadge: doc.showBadge,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** AC5 — the kill switch outranks `published`; this is the whole precedence rule. */
export function isFormServable(form: Pick<FormDoc, "enabled" | "published">): boolean {
  return form.enabled && form.published;
}

/** AC1 — every requested key must name a real field on the entity; none invented. */
export function resolveFormFields(
  requested: { key: string }[],
  entityFields: readonly FieldDef[],
): FieldDef[] {
  const byKey = new Map(entityFields.map((f) => [f.key, f]));
  const seen = new Set<string>();
  const resolved: FieldDef[] = [];
  for (const { key } of requested) {
    if (seen.has(key)) {
      throw new AppError("VALIDATION_FAILED", "Invalid request body", {
        source: "body",
        fields: { fields: `Duplicate field key "${key}"` },
      });
    }
    seen.add(key);
    const fieldDef = byKey.get(key);
    if (!fieldDef) {
      throw new AppError("VALIDATION_FAILED", "Invalid request body", {
        source: "body",
        fields: { fields: `Unknown field "${key}" on this entity` },
      });
    }
    resolved.push(fieldDef);
  }
  return resolved;
}

/** The meter a form's visibility charges — AC4's public/internal split. */
export function meterForVisibility(visibility: Visibility): Meter {
  return visibility === "public" ? "active_forms" : "internal_forms";
}

export type FormDeps = {
  repo: Repository<FormDoc>;
  getEntity: (ctx: Ctx, entityId: string) => Promise<EntityView>;
  consumeQuota: (ctx: Ctx, meter: Meter, amount?: number) => Promise<QuotaResult>;
  accounts: AccountStore;
};

const defaultRepo = createRepository<FormDoc>("forms");

function resolveDeps(overrides: Partial<FormDeps> = {}): FormDeps {
  return {
    repo: overrides.repo ?? defaultRepo,
    getEntity: overrides.getEntity ?? ((ctx, entityId) => getEntityDefault(ctx, entityId)),
    consumeQuota:
      overrides.consumeQuota ??
      ((ctx, meter, amount) => consumeQuotaDefault(ctx, meter, amount)),
    accounts: overrides.accounts ?? mongoAccountStore(),
  };
}

async function findFormOrThrow(deps: FormDeps, ctx: Ctx, formId: string) {
  const doc = await deps.repo.findById(ctx, formId);
  if (!doc) throw new AppError("NOT_FOUND", "Form not found");
  return doc;
}

/**
 * AC1 — bound to an entity, field list a real subset. Internal forms reserve
 * their own quota up front (no publish step); public forms cost nothing until
 * published (AC4).
 */
export async function createForm(
  ctx: Ctx,
  input: unknown,
  overrides: Partial<FormDeps> = {},
): Promise<FormView> {
  const deps = resolveDeps(overrides);
  const parsed = parse(createFormSchema, input, "body");

  const entity = await deps.getEntity(ctx, parsed.entityId);
  const fields = resolveFormFields(parsed.fields, entity.fields);

  if (await deps.repo.findOne(ctx, { slug: parsed.slug } as Filter<FormDoc>)) {
    throw new AppError("CONFLICT", "A form with that slug already exists");
  }

  if (parsed.visibility === "internal") {
    await deps.consumeQuota(ctx, "internal_forms");
  }

  try {
    const doc = await deps.repo.insertOne(ctx, {
      entityDefId: new ObjectId(parsed.entityId),
      name: parsed.name,
      slug: parsed.slug,
      publicSlug: null,
      visibility: parsed.visibility,
      published: false,
      enabled: true,
      killSwitchAt: null,
      killSwitchBy: null,
      fields,
      showBadge: true,
      deletedAt: null,
    });
    return toView(doc);
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError("CONFLICT", "A form with that slug already exists");
    }
    throw error;
  }
}

export async function listForms(
  ctx: Ctx,
  query: { cursor?: string; limit?: unknown },
  overrides: Partial<FormDeps> = {},
) {
  const deps = resolveDeps(overrides);
  const { items, meta } = await deps.repo.listPage(ctx, {
    cursor: query.cursor,
    limit: clampLimit(query.limit),
  });
  return { items: items.map(toView), meta };
}

/** AC6 — another tenant's form is 404, not 403 (repository scoping). */
export async function getForm(
  ctx: Ctx,
  formId: string,
  overrides: Partial<FormDeps> = {},
): Promise<FormView> {
  const deps = resolveDeps(overrides);
  const doc = await findFormOrThrow(deps, ctx, formId);
  return toView(doc);
}

/** AC1 (on update too), AC5 — the kill switch is timestamped and attributed. */
export async function updateForm(
  ctx: Ctx,
  formId: string,
  input: unknown,
  overrides: Partial<FormDeps> = {},
): Promise<FormView> {
  const deps = resolveDeps(overrides);
  const parsed = parse(updateFormSchema, input, "body");
  const existing = await findFormOrThrow(deps, ctx, formId);

  let fields: FieldDef[] | undefined;
  if (parsed.fields) {
    const entity = await deps.getEntity(ctx, existing.entityDefId.toHexString());
    fields = resolveFormFields(parsed.fields, entity.fields);
  }

  const killSwitchChanged = parsed.enabled !== undefined && parsed.enabled !== existing.enabled;
  if (killSwitchChanged) {
    createLogger({ requestId: ctx.requestId }).info("forms.kill_switch.toggled", {
      tenantId: ctx.tenantId,
      formId,
      enabled: parsed.enabled,
    });
  }

  const updated = await deps.repo.updateOne(ctx, { _id: existing._id } as Filter<FormDoc>, {
    $set: {
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(fields !== undefined ? { fields } : {}),
      ...(parsed.enabled !== undefined ? { enabled: parsed.enabled } : {}),
      ...(killSwitchChanged
        ? { killSwitchAt: new Date(), killSwitchBy: new ObjectId(ctx.userId) }
        : {}),
    },
  });
  if (!updated) throw new AppError("NOT_FOUND", "Form not found");
  return toView(updated);
}

export async function deleteForm(
  ctx: Ctx,
  formId: string,
  overrides: Partial<FormDeps> = {},
): Promise<void> {
  const deps = resolveDeps(overrides);
  const deleted = await deps.repo.softDelete(ctx, formId);
  if (!deleted) throw new AppError("NOT_FOUND", "Form not found");
}

/**
 * AC2, AC4 — assigns a globally-unique `publicSlug` and reserves the
 * `active_forms` quota before the write. A collision on the partial unique
 * index (scripts/create-indexes.ts) is the 409; quota is reserved first, so a
 * quota refusal never touches the row (the same ordering as
 * src/server/services/entities.ts's createEntity).
 */
export async function publishForm(
  ctx: Ctx,
  formId: string,
  overrides: Partial<FormDeps> = {},
): Promise<FormView> {
  const deps = resolveDeps(overrides);
  const existing = await findFormOrThrow(deps, ctx, formId);

  if (existing.visibility !== "public") {
    throw new AppError("CONFLICT", "Only public forms can be published");
  }
  if (existing.published) return toView(existing);

  const tenant = await deps.accounts.findTenantById(ctx.tenantId);
  if (!tenant) throw new AppError("NOT_FOUND", "Form not found");
  const publicSlug = `${tenant.slug}/${existing.slug}`;

  await deps.consumeQuota(ctx, "active_forms");

  try {
    const updated = await deps.repo.updateOne(ctx, { _id: existing._id } as Filter<FormDoc>, {
      $set: { published: true, publicSlug },
    });
    if (!updated) throw new AppError("NOT_FOUND", "Form not found");
    return toView(updated);
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError("CONFLICT", "That public URL is already taken");
    }
    throw error;
  }
}

/** AC3 — retains the definition and every prior submission; nothing deleted. */
export async function unpublishForm(
  ctx: Ctx,
  formId: string,
  overrides: Partial<FormDeps> = {},
): Promise<FormView> {
  const deps = resolveDeps(overrides);
  const existing = await findFormOrThrow(deps, ctx, formId);
  if (!existing.published) return toView(existing);

  const updated = await deps.repo.updateOne(ctx, { _id: existing._id } as Filter<FormDoc>, {
    $set: { published: false, publicSlug: null },
  });
  if (!updated) throw new AppError("NOT_FOUND", "Form not found");
  return toView(updated);
}

/**
 * AC7 — called from entities.ts's deleteEntity so a deleted entity never
 * leaves a form serving a dead schema. Unpublish only: the definition and any
 * submissions stay exactly as AC3 requires elsewhere.
 */
export async function unpublishFormsForEntity(
  ctx: Ctx,
  entityId: string,
  overrides: Partial<FormDeps> = {},
): Promise<void> {
  const deps = resolveDeps(overrides);
  const forms = await deps.repo.find(ctx, {
    entityDefId: new ObjectId(entityId),
    published: true,
  } as Filter<FormDoc>);
  for (const form of forms) {
    await deps.repo.updateOne(ctx, { _id: form._id } as Filter<FormDoc>, {
      $set: { published: false, publicSlug: null },
    });
  }
}
