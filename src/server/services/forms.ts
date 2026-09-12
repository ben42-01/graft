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
import { MongoServerError, ObjectId, type Filter, type WithId } from "mongodb";
import { z } from "zod";
import type { Ctx } from "@/server/context";
import { getDb } from "@/server/db/mongo";
import { AppError } from "@/server/http/envelope";
import { clampLimit } from "@/server/http/pagination";
import { parse } from "@/server/http/validate";
import { createLogger } from "@/server/log";
import { mongoAccountStore, type AccountStore } from "@/server/auth/accounts-store";
import { getEntity as getEntityDefault, type EntityView, type FieldDef } from "./entities";
import { mediaUrl } from "./media";
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

/**
 * How many record fields a catalogue card may show. Six is a product
 * decision: a card is a glance, and past half a dozen values it has become a
 * table that happens to have a picture on it.
 */
export const MAX_CATALOGUE_FIELDS = 6;

/** The hard ceiling on a public page size, independent of what a tenant asks
 * for. A public, paginated read of tenant data is a scraping surface; the cap
 * is what keeps one request from being a bulk export. */
export const MAX_CATALOGUE_PAGE_SIZE = 24;

export const DEFAULT_CATALOGUE_PAGE_SIZE = 12;

/**
 * Catalogue mode — the form stops being a blank page and becomes a front for
 * the business's own records (docs/Graft.md §4.4).
 *
 * Three things are deliberate about this shape:
 *
 *   - **`entityId` is its own field, not the form's `entityDefId`.** A form
 *     writes submissions as records of one entity ("Bookings") and browses
 *     records of another ("Rental Items"). Collapsing the two would mean a
 *     visitor browsing the submissions of everyone before them.
 *   - **`fields` is an allowlist, and it is the *only* thing made public.**
 *     A record carries things a customer must never see — cost price,
 *     supplier, internal notes — so the public projection is built from this
 *     list rather than from the record minus a denylist. A field added to the
 *     entity later is private until someone says otherwise, which is the only
 *     safe default.
 *   - **`selectionKey` names where the chosen record lands.** It is a field on
 *     the *form's* entity, so a submission records which product it was
 *     about — which is exactly what an order needs downstream.
 */
export const catalogueSchema = z.object({
  entityId: objectIdHex,
  fields: z.array(fieldKey).max(MAX_CATALOGUE_FIELDS).default([]),
  imageField: fieldKey.nullable().default(null),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(MAX_CATALOGUE_PAGE_SIZE)
    .default(DEFAULT_CATALOGUE_PAGE_SIZE),
  selectionKey: fieldKey.nullable().default(null),
});

export type CatalogueInput = z.input<typeof catalogueSchema>;

/**
 * A year. Past this a "booking" is a lease, and the number is far more likely
 * to be a typo in a duration box than a real intention.
 */
export const MAX_BOOKING_MINUTES = 366 * 24 * 60;

/** How the resource's rate is read off its record — `pricing.ts`'s `RateBasis`,
 * restated here because that module cannot be imported by the client mirror. */
export const RATE_BASES = ["hourly", "daily", "flat"] as const;

/**
 * Booking mode — what turns a submission into an order against real capacity
 * (docs/BMS_EXTENSION.md §3.1, where `CustomerAction` carries an `order_id`
 * and `ResourceAllocation` an `action_id`).
 *
 * Three things are deliberate about this shape:
 *
 *   - **It names fields, it does not add them.** A booking form is an ordinary
 *     form whose entity happens to have a start date on it; this config only
 *     says *which* of its fields mean "when". Inventing platform-owned date
 *     fields would make a booking form something a tenant cannot design.
 *   - **The resource is the catalogue selection, never a field.** Which boat
 *     was booked is `_selection` — proved to exist in the form's own catalogue
 *     before anything is written (`resolveSelection`) — so it is not something
 *     a visitor can type. That is why booking mode requires a catalogue with a
 *     `selectionKey` and refuses to be configured without one.
 *   - **End *or* duration, never both.** "Pick a start and an end" and "pick a
 *     start, it is always 90 minutes" are the two real shapes of a booking
 *     form, and a config that allowed both would have to decide which one wins
 *     at submit time — in front of a customer, with money attached.
 */
export const bookingSchema = z
  .object({
    /** A `date` field on the form's own entity: when the booking starts. */
    startKey: fieldKey,
    /** A `date` field for the end, or null when `durationMinutes` is set. */
    endKey: fieldKey.nullable().default(null),
    /** A fixed length, for forms that ask only for a start time. */
    durationMinutes: z.number().int().min(1).max(MAX_BOOKING_MINUTES).nullable().default(null),
    /** A `number` field: how many of a pooled resource. Absent means one. */
    quantityKey: fieldKey.nullable().default(null),
    rateBasis: z.enum(RATE_BASES).default("hourly"),
    /** Charged upfront, as a percent of the total. Null means no deposit. */
    depositPercent: z.number().int().min(1).max(100).nullable().default(null),
  })
  .refine((v) => (v.endKey === null) !== (v.durationMinutes === null), {
    message: "Give either an end-date field or a fixed duration, not both",
  });

export type BookingInput = z.input<typeof bookingSchema>;

export const createFormSchema = z.object({
  entityId: objectIdHex,
  name: z.string().trim().min(1).max(120),
  slug: formSlugSchema,
  visibility: z.enum(VISIBILITIES),
  fields: z.array(formFieldRefSchema).min(1).max(100),
  /** Optional at creation — most forms are never catalogues. */
  catalogue: catalogueSchema.nullable().optional(),
  /** Optional at creation, and only legal alongside a catalogue that has a
   * `selectionKey` — see `resolveBooking`. */
  booking: bookingSchema.nullable().optional(),
});

export const updateFormSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    fields: z.array(formFieldRefSchema).min(1).max(100).optional(),
    /** The kill switch (AC5). Independent of `published`. */
    enabled: z.boolean().optional(),
    /** `null` turns catalogue mode off; absent leaves it as it was. */
    catalogue: catalogueSchema.nullable().optional(),
    /** `null` turns booking mode off; absent leaves it as it was. */
    booking: bookingSchema.nullable().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.fields !== undefined ||
      v.enabled !== undefined ||
      v.catalogue !== undefined ||
      v.booking !== undefined,
    { message: "Nothing to update" },
  );

/**
 * How many images a form carries in its own right.
 *
 * This was 3 — a small carousel of product photos attached to the form. That
 * was the wrong home for them: the photos were form-only content that could
 * never be the catalogue, because the catalogue is records, so a business with
 * forty products had one entity full of them and a form that could show three
 * pictures unrelated to any of them.
 *
 * The product photos now live on the record (`image` field type,
 * record-media.ts) and the form paginates through them (`catalogue`). What is
 * left here is one hero image — a banner for the advert, which is a genuinely
 * different job from a picture of a thing for sale. Existing carousels keep
 * rendering; `scripts/migrate/` trims them to their first slide.
 */
export const MAX_CAROUSEL_IMAGES = 1;

/** What the cap used to be. Read by the migration and by `toCarouselView`,
 * which must keep rendering carousels written before the change. */
export const LEGACY_MAX_CAROUSEL_IMAGES = 3;

/**
 * One slide. `alt` is required rather than optional — this renders on a public
 * page for anonymous visitors, so a missing alternative text is an
 * accessibility defect the builder should be made to fix, not a default the
 * server silently accepts. Empty string is still allowed for the genuinely
 * decorative case; it just has to be chosen.
 */
export const carouselItemSchema = z.object({
  mediaId: objectIdHex,
  alt: z.string().trim().max(160).default(""),
});

export const updateCarouselSchema = z.object({
  images: z.array(carouselItemSchema).max(MAX_CAROUSEL_IMAGES),
});

export type UpdateCarouselInput = z.input<typeof updateCarouselSchema>;

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
  /**
   * The product carousel shown above the fields on the public page. Ordered —
   * position in the array *is* slide order, so a reorder is a whole-array
   * write rather than an index nobody keeps consistent. Absent on documents
   * written before carousels existed, which `toView` reads as empty.
   */
  carousel?: { mediaId: ObjectId; alt: string }[];
  /**
   * Catalogue mode — absent/`null` on an ordinary form. Stored resolved: the
   * keys here have already been checked against the catalogue entity's own
   * fields, so a reader never has to re-derive whether they are real.
   */
  catalogue?: CatalogueConfig | null;
  /**
   * Booking mode — absent/`null` on an ordinary form. Stored resolved, the
   * same as `catalogue`: the keys named here were checked against the form's
   * own field list when it was saved, so the public submit path never
   * re-derives whether they are real.
   */
  booking?: BookingConfig | null;
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
  /** Slide order, each already carrying the URL a browser fetches it from. */
  carousel: CarouselItemView[];
  catalogue: CatalogueView | null;
  booking: BookingConfig | null;
  showBadge: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type CarouselItemView = { mediaId: string; alt: string; url: string };

/**
 * A booking config as stored. Every field is a plain string or number — there
 * is no id in here, because the only id a booking needs is the catalogue
 * selection the visitor makes at submit time.
 */
export type BookingConfig = {
  startKey: string;
  endKey: string | null;
  durationMinutes: number | null;
  quantityKey: string | null;
  rateBasis: (typeof RATE_BASES)[number];
  depositPercent: number | null;
};

export type CatalogueConfig = {
  entityDefId: ObjectId;
  fields: string[];
  imageField: string | null;
  pageSize: number;
  selectionKey: string | null;
};

export type CatalogueView = {
  entityId: string;
  fields: string[];
  imageField: string | null;
  pageSize: number;
  selectionKey: string | null;
};

export function toCatalogueView(
  catalogue: CatalogueConfig | null | undefined,
): CatalogueView | null {
  if (!catalogue) return null;
  return {
    entityId: catalogue.entityDefId.toHexString(),
    fields: catalogue.fields,
    imageField: catalogue.imageField,
    pageSize: catalogue.pageSize,
    selectionKey: catalogue.selectionKey,
  };
}

const isDuplicateKey = (error: unknown): boolean =>
  error instanceof MongoServerError && error.code === 11000;

/** Absent (pre-carousel documents) and empty are the same thing to a reader. */
export function toCarouselView(carousel: FormDoc["carousel"]): CarouselItemView[] {
  return (carousel ?? []).map((item) => ({
    mediaId: item.mediaId.toHexString(),
    alt: item.alt,
    url: mediaUrl(item.mediaId.toHexString()),
  }));
}

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
    carousel: toCarouselView(doc.carousel),
    catalogue: toCatalogueView(doc.catalogue),
    booking: doc.booking ?? null,
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

/**
 * Turns a catalogue *request* into a stored config, refusing every way it can
 * name something that isn't there.
 *
 * The checks run against two different entities on purpose: `fields` and
 * `imageField` describe the records a visitor browses (the catalogue entity),
 * while `selectionKey` describes where the chosen record's id is written on
 * the way back in (the form's own entity). Validating both against one schema
 * is the bug this signature exists to make impossible.
 *
 * Resolution happens on write, not on read: a stored catalogue names keys
 * that were real when it was saved, so the public read path — the one facing
 * anonymous traffic — never has to re-derive whether a key is legitimate.
 */
export function resolveCatalogue(
  input: z.infer<typeof catalogueSchema>,
  catalogueEntityFields: readonly FieldDef[],
  submissionEntityFields: readonly FieldDef[],
): CatalogueConfig {
  const byKey = new Map(catalogueEntityFields.map((field) => [field.key, field]));

  const seen = new Set<string>();
  for (const key of input.fields) {
    if (!byKey.has(key)) {
      throw new AppError("VALIDATION_FAILED", "Invalid request body", {
        source: "body",
        fields: { catalogue: `Unknown field "${key}" on the catalogue entity` },
      });
    }
    if (seen.has(key)) {
      throw new AppError("VALIDATION_FAILED", "Invalid request body", {
        source: "body",
        fields: { catalogue: `Duplicate field "${key}"` },
      });
    }
    seen.add(key);
  }

  if (input.imageField !== null) {
    const image = byKey.get(input.imageField);
    if (!image) {
      throw new AppError("VALIDATION_FAILED", "Invalid request body", {
        source: "body",
        fields: { catalogue: `Unknown field "${input.imageField}" on the catalogue entity` },
      });
    }
    if (image.type !== "image") {
      throw new AppError("VALIDATION_FAILED", "Invalid request body", {
        source: "body",
        fields: { catalogue: `Field "${input.imageField}" does not hold an image` },
      });
    }
  }

  if (input.selectionKey !== null) {
    // Deliberately checked against the *submission* entity: this is where the
    // visitor's choice is written, not something they browse.
    const target = submissionEntityFields.find((field) => field.key === input.selectionKey);
    if (!target) {
      throw new AppError("VALIDATION_FAILED", "Invalid request body", {
        source: "body",
        fields: {
          catalogue: `Unknown field "${input.selectionKey}" on the form's own entity`,
        },
      });
    }
    if (target.type !== "text") {
      throw new AppError("VALIDATION_FAILED", "Invalid request body", {
        source: "body",
        fields: {
          catalogue: `Field "${input.selectionKey}" must be a text field to hold a record id`,
        },
      });
    }
  }

  return {
    entityDefId: new ObjectId(input.entityId),
    fields: input.fields,
    imageField: input.imageField,
    pageSize: input.pageSize,
    selectionKey: input.selectionKey,
  };
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
 * Turns a booking *request* into a stored config, refusing every way it can
 * name something that isn't there — the same write-time resolution
 * `resolveCatalogue` does, and for the same reason: the path that reads this
 * is the unauthenticated submit path, which must never have to wonder whether
 * a key is legitimate.
 *
 * The checks are about *types*, not just existence. A start key pointing at a
 * text field would compile a schema that accepts "next tuesday" and hand an
 * Invalid Date to the availability engine, which would then block a window
 * from NaN to NaN. Better to refuse it in the builder.
 */
export function resolveBooking(
  input: z.infer<typeof bookingSchema>,
  formFields: readonly FieldDef[],
  catalogue: CatalogueConfig | null,
): BookingConfig {
  const byKey = new Map(formFields.map((field) => [field.key, field]));

  // Booking mode without a catalogue selection has nothing to book: the
  // resource *is* the selection (see `bookingSchema`'s docs).
  if (!catalogue || catalogue.selectionKey === null) {
    throw new AppError("VALIDATION_FAILED", "Invalid request body", {
      source: "body",
      fields: {
        booking:
          "Booking mode needs catalogue mode with a selection field — that is what says which resource was booked",
      },
    });
  }

  const requireField = (key: string, type: FieldDef["type"], label: string) => {
    const field = byKey.get(key);
    if (!field) {
      throw new AppError("VALIDATION_FAILED", "Invalid request body", {
        source: "body",
        fields: { booking: `Unknown field "${key}" on this form` },
      });
    }
    if (field.type !== type) {
      throw new AppError("VALIDATION_FAILED", "Invalid request body", {
        source: "body",
        fields: {
          booking: `Field "${key}" must be a ${label} to hold ${
            type === "date" ? "a booking time" : "a quantity"
          }`,
        },
      });
    }
  };

  requireField(input.startKey, "date", "date field");
  if (input.endKey !== null) {
    if (input.endKey === input.startKey) {
      throw new AppError("VALIDATION_FAILED", "Invalid request body", {
        source: "body",
        fields: { booking: "The start and end of a booking cannot be the same field" },
      });
    }
    requireField(input.endKey, "date", "date field");
  }
  if (input.quantityKey !== null) requireField(input.quantityKey, "number", "number field");

  return {
    startKey: input.startKey,
    endKey: input.endKey,
    durationMinutes: input.durationMinutes,
    quantityKey: input.quantityKey,
    rateBasis: input.rateBasis,
    depositPercent: input.depositPercent,
  };
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
  const catalogue = parsed.catalogue
    ? resolveCatalogue(
        parsed.catalogue,
        (await deps.getEntity(ctx, parsed.catalogue.entityId)).fields,
        entity.fields,
      )
    : null;
  const booking = parsed.booking ? resolveBooking(parsed.booking, fields, catalogue) : null;

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
      carousel: [],
      catalogue,
      booking,
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

  // `undefined` leaves catalogue mode alone; an explicit `null` turns it off.
  let catalogue: CatalogueConfig | null | undefined;
  if (parsed.catalogue !== undefined) {
    catalogue = parsed.catalogue
      ? resolveCatalogue(
          parsed.catalogue,
          (await deps.getEntity(ctx, parsed.catalogue.entityId)).fields,
          (await deps.getEntity(ctx, existing.entityDefId.toHexString())).fields,
        )
      : null;
  }

  // Booking is resolved against what the form will look like *after* this
  // update, not what it looks like now: a call that swaps the field list and
  // the booking config together must be checked as one state, or it would be
  // possible to keep a booking config pointing at a field being removed.
  let booking: BookingConfig | null | undefined;
  if (parsed.booking !== undefined) {
    booking = parsed.booking
      ? resolveBooking(
          parsed.booking,
          fields ?? existing.fields,
          catalogue !== undefined ? catalogue : (existing.catalogue ?? null),
        )
      : null;
  }

  // A field list or catalogue edit can orphan a booking config that nobody
  // touched in this call — removing the field the start date lived on, or
  // switching the catalogue off underneath it. Re-resolving the untouched
  // config against the resulting state turns that into a refusal the builder
  // can act on, rather than a form that keeps taking bookings it can no
  // longer price.
  if (
    booking === undefined &&
    existing.booking &&
    (fields !== undefined || catalogue !== undefined)
  ) {
    resolveBooking(
      existing.booking,
      fields ?? existing.fields,
      catalogue !== undefined ? catalogue : (existing.catalogue ?? null),
    );
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
      ...(catalogue !== undefined ? { catalogue } : {}),
      ...(booking !== undefined ? { booking } : {}),
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
 * GRAFT-09 — the public submission path's only entry point into `forms`.
 * There is no ctx yet: discovering which tenant owns this slug *is* the point
 * of the lookup, so it reads the collection directly rather than through the
 * ctx-scoped repository above (same reasoning as
 * src/server/auth/accounts-store.ts). Never called from an authenticated path.
 */
export async function findByPublicSlug(publicSlug: string): Promise<WithId<FormDoc> | null> {
  const db = await getDb();
  return db.collection<FormDoc>("forms").findOne({ publicSlug, deletedAt: null });
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
