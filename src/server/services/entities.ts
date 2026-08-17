/**
 * Entity Builder — tenant-defined schemas (GRAFT-06, docs/Graft.md §4.2,
 * docs/BACKEND.md §1.3).
 *
 * `entity_defs` is the abstraction that makes Graft generic: a tenant declares
 * its own fields, and every later feature (records, forms) validates against a
 * Zod schema *compiled* from that declaration rather than a fixed one. Three
 * things matter enough to call out:
 *
 *   - **The cache key is `tenantId:entityId:schemaVersion`** (AC3). That is the
 *     whole invalidation strategy: a version bump changes the key, so the old
 *     compiled schema is simply never looked up again rather than evicted.
 *   - **`schemaVersion` bumps on structural change, not on relabelling** (AC4).
 *     The comparison excludes `label` on purpose — the compiled schema does not
 *     depend on it, so a rename cannot invalidate anything that read it.
 *   - **Field keys are whitelisted identifiers.** They end up in Mongo paths
 *     (records, GRAFT-07) and must never carry operator syntax (`$`, `.`).
 */
import { ObjectId, MongoServerError, type Filter } from "mongodb";
import { z } from "zod";
import type { Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import { clampLimit } from "@/server/http/pagination";
import { parse } from "@/server/http/validate";
import { consumeQuota as consumeQuotaDefault, type Meter, type QuotaResult } from "./meters";
import { createRepository, type Repository } from "@/server/repositories/base";

export const FIELD_TYPES = [
  "text",
  "number",
  "date",
  "select",
  "checkbox",
  "email",
  "phone",
  "file",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Ends up in a Mongo path (records, GRAFT-07) — never `$`, never `.`. */
const identifier = (max: number) =>
  z
    .string()
    .regex(
      /^[a-z][a-z0-9_]*$/,
      "Use lowercase letters, digits and underscores, starting with a letter",
    )
    .max(max);

const objectIdHex = z.string().regex(/^[0-9a-f]{24}$/i, "Expected a 24-character id");

export const fieldDefSchema = z
  .object({
    key: identifier(64),
    label: z.string().trim().min(1).max(120),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().optional().default(false),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    options: z.array(z.string().trim().min(1).max(120)).min(1).max(50).optional(),
  })
  .refine((f) => f.type !== "select" || (f.options && f.options.length > 0), {
    message: "A select field needs at least one option",
    path: ["options"],
  });

export type FieldDef = z.infer<typeof fieldDefSchema>;

export const createEntitySchema = z.object({
  key: identifier(64),
  name: z.string().trim().min(1).max(120),
  fields: z.array(fieldDefSchema).min(1).max(100),
});

/** `key` is the entity's identity and is immutable once created. */
export const updateEntitySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    fields: z.array(fieldDefSchema).min(1).max(100).optional(),
  })
  .refine((v) => v.name !== undefined || v.fields !== undefined, {
    message: "Nothing to update",
  });

export const listEntitiesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.union([z.string(), z.number()]).optional(),
});

export const entityIdParamSchema = z.object({ entityId: objectIdHex });

export type CreateEntityInput = z.input<typeof createEntitySchema>;
export type UpdateEntityInput = z.input<typeof updateEntitySchema>;

export type EntityDefDoc = {
  tenantId: ObjectId;
  key: string;
  name: string;
  fields: FieldDef[];
  schemaVersion: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type EntityView = {
  id: string;
  key: string;
  name: string;
  fields: FieldDef[];
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
};

const isDuplicateKey = (error: unknown): boolean =>
  error instanceof MongoServerError && error.code === 11000;

function toView(doc: { _id: ObjectId } & EntityDefDoc): EntityView {
  return {
    id: doc._id.toHexString(),
    key: doc.key,
    name: doc.name,
    fields: doc.fields,
    schemaVersion: doc.schemaVersion,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function assertUniqueFieldKeys(fields: FieldDef[]): void {
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.key)) {
      throw new AppError("VALIDATION_FAILED", "Invalid request body", {
        source: "body",
        fields: { fields: `Duplicate field key "${field.key}"` },
      });
    }
    seen.add(field.key);
  }
}

/**
 * AC2 — one field, one Zod type. Pure and side-effect-free so it is cheap to
 * call on every cache miss and easy to unit test in isolation.
 */
export function compileFieldSchema(field: FieldDef): z.ZodTypeAny {
  let base: z.ZodTypeAny;
  switch (field.type) {
    case "text":
      base = z.string();
      if (field.min !== undefined) base = (base as z.ZodString).min(field.min);
      if (field.max !== undefined) base = (base as z.ZodString).max(field.max);
      break;
    case "number": {
      let num = z.number();
      if (field.min !== undefined) num = num.min(field.min);
      if (field.max !== undefined) num = num.max(field.max);
      base = num;
      break;
    }
    case "date":
      base = z.coerce.date();
      break;
    case "select":
      base =
        field.options && field.options.length > 0
          ? z.enum(field.options as [string, ...string[]])
          : z.string();
      break;
    case "checkbox":
      base = z.boolean();
      break;
    case "email":
      base = z.string().email();
      break;
    case "phone":
      base = z.string().regex(/^[0-9+\-() ]{5,25}$/, "Not a valid phone number");
      break;
    case "file":
      base = z.string().min(1);
      break;
  }
  return field.required ? base : base.optional();
}

/**
 * AC2, AC3, AC6 — a whole entity as one Zod object, unknown fields rejected so
 * the boundary matches "never pass a raw client filter/payload into Mongo".
 */
export function compileEntitySchema(fields: FieldDef[]): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) shape[field.key] = compileFieldSchema(field);
  return z.object(shape).strict();
}

export type SchemaCache = Map<string, z.ZodTypeAny>;
const defaultCache: SchemaCache = new Map();

/**
 * AC3 — cached per `tenantId:entityId:schemaVersion`. A second call with the
 * same key returns the same compiled schema without invoking `compile` again;
 * a version bump is a different key, which is the entire invalidation story.
 */
export function getCompiledSchema(
  tenantId: string,
  entityId: string,
  schemaVersion: number,
  fields: FieldDef[],
  cache: SchemaCache = defaultCache,
  compile: (fields: FieldDef[]) => z.ZodTypeAny = compileEntitySchema,
): z.ZodTypeAny {
  const key = `${tenantId}:${entityId}:${schemaVersion}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const compiled = compile(fields);
  cache.set(key, compiled);
  return compiled;
}

/** Everything but `label` — the compiled schema never depends on it (AC4). */
const fieldSignature = (f: FieldDef) => ({
  key: f.key,
  type: f.type,
  required: f.required,
  min: f.min,
  max: f.max,
  options: f.options,
});

/**
 * AC4 — bumps on any structural change (a new required field, a removed
 * field, a changed type/required/min/max/options), never on a relabel. Field
 * order is normalised by key so reordering the same fields is not a change.
 */
export function nextSchemaVersion(
  oldFields: FieldDef[],
  newFields: FieldDef[],
  currentVersion: number,
): number {
  const sig = (fields: FieldDef[]) =>
    JSON.stringify([...fields].sort((a, b) => a.key.localeCompare(b.key)).map(fieldSignature));
  return sig(oldFields) === sig(newFields) ? currentVersion : currentVersion + 1;
}

export type EntityDeps = {
  repo: Repository<EntityDefDoc>;
  consumeQuota: (ctx: Ctx, meter: Meter, amount?: number) => Promise<QuotaResult>;
  cache: SchemaCache;
  /** AC7 (GRAFT-08) — unpublishes any form bound to the entity being deleted. */
  unpublishFormsForEntity: (ctx: Ctx, entityId: string) => Promise<void>;
};

const defaultRepo = createRepository<EntityDefDoc>("entity_defs");

/**
 * Dynamic, not static: forms.ts imports getEntity from this module, so a
 * static import the other way would be a cycle. The import only ever
 * happens on the delete path, not on module load.
 */
const defaultUnpublishFormsForEntity = (ctx: Ctx, entityId: string) =>
  import("./forms").then((forms) => forms.unpublishFormsForEntity(ctx, entityId));

function resolveDeps(overrides: Partial<EntityDeps> = {}): EntityDeps {
  return {
    repo: overrides.repo ?? defaultRepo,
    consumeQuota:
      overrides.consumeQuota ??
      ((ctx, meter, amount) => consumeQuotaDefault(ctx, meter, amount)),
    cache: overrides.cache ?? defaultCache,
    unpublishFormsForEntity:
      overrides.unpublishFormsForEntity ?? defaultUnpublishFormsForEntity,
  };
}

/**
 * AC1, AC5 — quota is reserved before the write, so a refusal never leaves a
 * partial entity behind. The duplicate-key path (AC1's 409) is the unique
 * index on (tenantId, key) (scripts/create-indexes.ts); there is no reliable
 * way to give the reserved quota back on that race, so the pre-check below
 * exists to make it rare, not to make it impossible — see PR "Outside guidance".
 */
export async function createEntity(
  ctx: Ctx,
  input: unknown,
  overrides: Partial<EntityDeps> = {},
): Promise<EntityView> {
  const deps = resolveDeps(overrides);
  const parsed = parse(createEntitySchema, input, "body");
  assertUniqueFieldKeys(parsed.fields);

  if (await deps.repo.findOne(ctx, { key: parsed.key } as Filter<EntityDefDoc>)) {
    throw new AppError("CONFLICT", "An entity with that key already exists");
  }

  await deps.consumeQuota(ctx, "entities");

  try {
    const doc = await deps.repo.insertOne(ctx, {
      key: parsed.key,
      name: parsed.name,
      fields: parsed.fields,
      schemaVersion: 1,
      deletedAt: null,
    });
    return toView(doc);
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError("CONFLICT", "An entity with that key already exists");
    }
    throw error;
  }
}

export async function listEntities(
  ctx: Ctx,
  query: { cursor?: string; limit?: unknown },
  overrides: Partial<EntityDeps> = {},
) {
  const deps = resolveDeps(overrides);
  const { items, meta } = await deps.repo.listPage(ctx, {
    cursor: query.cursor,
    limit: clampLimit(query.limit),
  });
  return { items: items.map(toView), meta };
}

export async function getEntity(
  ctx: Ctx,
  entityId: string,
  overrides: Partial<EntityDeps> = {},
): Promise<EntityView> {
  const deps = resolveDeps(overrides);
  const doc = await deps.repo.findById(ctx, entityId);
  if (!doc) throw new AppError("NOT_FOUND", "Entity not found");
  return toView(doc);
}

/** AC4, AC6 — the version bump lives here, next to the only place `fields` is written. */
export async function updateEntity(
  ctx: Ctx,
  entityId: string,
  input: unknown,
  overrides: Partial<EntityDeps> = {},
): Promise<EntityView> {
  const deps = resolveDeps(overrides);
  const parsed = parse(updateEntitySchema, input, "body");

  const existing = await deps.repo.findById(ctx, entityId);
  if (!existing) throw new AppError("NOT_FOUND", "Entity not found");

  if (parsed.fields) assertUniqueFieldKeys(parsed.fields);
  const schemaVersion = parsed.fields
    ? nextSchemaVersion(existing.fields, parsed.fields, existing.schemaVersion)
    : existing.schemaVersion;

  const updated = await deps.repo.updateOne(
    ctx,
    { _id: existing._id } as Filter<EntityDefDoc>,
    {
      $set: {
        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        ...(parsed.fields !== undefined ? { fields: parsed.fields } : {}),
        schemaVersion,
      },
    },
  );
  if (!updated) throw new AppError("NOT_FOUND", "Entity not found");
  return toView(updated);
}

/**
 * AC7 — soft delete only; records referencing this entity are untouched. Any
 * form bound to it is unpublished (GRAFT-08 AC7) so it stops serving a dead
 * schema rather than being left dangling.
 */
export async function deleteEntity(
  ctx: Ctx,
  entityId: string,
  overrides: Partial<EntityDeps> = {},
): Promise<void> {
  const deps = resolveDeps(overrides);
  const deleted = await deps.repo.softDelete(ctx, entityId);
  if (!deleted) throw new AppError("NOT_FOUND", "Entity not found");
  await deps.unpublishFormsForEntity(ctx, entityId);
}
