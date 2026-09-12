/**
 * The public catalogue — the records an anonymous visitor may browse on a
 * published form page (docs/Graft.md §4.4).
 *
 * This is a new unauthenticated *read* of tenant data, which makes it the
 * second-highest-risk surface in the product after `public-forms.ts`. Five
 * rules carry that weight, and each one is enforced here rather than trusted
 * to a caller:
 *
 *   - **The allowlist decides what is public, and nothing else does.** The
 *     projection is built from `catalogue.fields`, so a field added to the
 *     entity tomorrow is private until a human adds it to the list. A
 *     denylist would have the opposite default and would leak the next field
 *     someone adds.
 *   - **The page size is capped by the server.** A visitor's `limit` is
 *     clamped to the form's own `pageSize`, itself capped at
 *     `MAX_CATALOGUE_PAGE_SIZE`. A public paginated read is a scraping
 *     surface; the cap is what keeps one request from being a bulk export.
 *   - **Unknown, unpublished, killed and not-a-catalogue all return `null`.**
 *     The same collapse `getPublicFormPage` and `submitPublicForm` already
 *     make, so nothing here lets a scraper distinguish "never existed" from
 *     "existed and got killed".
 *   - **Deleted records are absent.** Soft-deleted records stay in the
 *     collection for the business; they are not merchandise.
 *   - **There is no `Ctx`.** A visitor presents a slug, not a token, so this
 *     reads the collections directly — the same reasoning `findByPublicSlug`
 *     and `accounts-store.ts` document. The tenant is discovered from the
 *     form, never accepted from the request.
 */
import { ObjectId, type Filter } from "mongodb";
import { getDb } from "@/server/db/mongo";
import { decodeCursor, encodeCursor, type PageMeta } from "@/server/http/pagination";
import type { FieldDef } from "./entities";
import {
  findByPublicSlug as findByPublicSlugDefault,
  formSlugSchema,
  isFormServable,
  type CatalogueConfig,
  type FormDoc,
} from "./forms";
import { mediaUrl } from "./media";
import type { RecordDoc } from "./records";
import type { EntityDefDoc } from "./entities";

export type CatalogueCardValue = { key: string; label: string; value: string };

export type CatalogueCard = {
  id: string;
  /** Absent when the catalogue has no image field, or this record has no
   * picture yet — a card without a photo is still a product. */
  image: { url: string; alt: string } | null;
  values: CatalogueCardValue[];
};

export type PublicCataloguePage = {
  items: CatalogueCard[];
  meta: PageMeta;
};

export type PublicCatalogueDeps = {
  findByPublicSlug: (publicSlug: string) => Promise<(FormDoc & { _id: ObjectId }) | null>;
  findEntity: (
    entityDefId: ObjectId,
    tenantId: ObjectId,
  ) => Promise<(EntityDefDoc & { _id: ObjectId }) | null>;
  findRecords: (
    filter: Filter<RecordDoc>,
    limit: number,
  ) => Promise<(RecordDoc & { _id: ObjectId })[]>;
};

function resolveDeps(overrides: Partial<PublicCatalogueDeps> = {}): PublicCatalogueDeps {
  return {
    findByPublicSlug: overrides.findByPublicSlug ?? findByPublicSlugDefault,
    findEntity:
      overrides.findEntity ??
      (async (entityDefId, tenantId) => {
        const db = await getDb();
        return db
          .collection<EntityDefDoc>("entity_defs")
          .findOne({ _id: entityDefId, tenantId, deletedAt: null });
      }),
    findRecords:
      overrides.findRecords ??
      (async (filter, limit) => {
        const db = await getDb();
        return db
          .collection<RecordDoc>("records")
          .find(filter, { sort: { _id: -1 }, limit })
          .toArray();
      }),
  };
}

/**
 * Renders one stored value as the string a card shows. Deliberately total —
 * every branch returns a string — because this runs on a public page and a
 * value of an unexpected shape must degrade to something harmless rather than
 * throw or leak a stringified object.
 */
export function formatCardValue(value: unknown, field: FieldDef): string {
  if (value === null || value === undefined) return "";
  switch (field.type) {
    case "checkbox":
      return value ? "Yes" : "No";
    case "date": {
      const date = value instanceof Date ? value : new Date(String(value));
      return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
    }
    case "number":
      return typeof value === "number" ? String(value) : "";
    default:
      // Anything that isn't already a primitive is *not* coerced: a nested
      // object on a text field is corrupt data, and "[object Object]" on a
      // public page is worse than an empty cell.
      return typeof value === "string" || typeof value === "number" ? String(value) : "";
  }
}

/**
 * Builds one card from a record, reading *only* the allowlisted keys. The
 * record's other fields never enter this function's output — that is the
 * whole point of it being a projection rather than a filter.
 */
export function toCard(
  record: RecordDoc & { _id: ObjectId },
  catalogue: CatalogueConfig,
  fieldsByKey: Map<string, FieldDef>,
): CatalogueCard {
  const values: CatalogueCardValue[] = [];
  for (const key of catalogue.fields) {
    const field = fieldsByKey.get(key);
    if (!field) continue; // The entity changed under a stored catalogue.
    values.push({ key, label: field.label, value: formatCardValue(record.data[key], field) });
  }

  let image: CatalogueCard["image"] = null;
  if (catalogue.imageField) {
    const mediaId = record.data[catalogue.imageField];
    if (typeof mediaId === "string" && /^[0-9a-f]{24}$/i.test(mediaId)) {
      // Alt text comes from the first allowlisted value rather than being
      // stored twice: on a product card the name *is* the description of the
      // picture, and a second field nobody maintains would go stale.
      image = { url: mediaUrl(mediaId), alt: values[0]?.value ?? "" };
    }
  }

  return { id: record._id.toHexString(), image, values };
}

/**
 * One page of a published form's catalogue. `null` for anything that is not a
 * live catalogue, whatever the reason.
 */
export async function getPublicCatalogue(
  tenantSlug: string,
  formSlug: string,
  query: { cursor?: string; limit?: unknown } = {},
  overrides: Partial<PublicCatalogueDeps> = {},
): Promise<PublicCataloguePage | null> {
  const deps = resolveDeps(overrides);

  const tenantParsed = formSlugSchema.safeParse(tenantSlug);
  const formParsed = formSlugSchema.safeParse(formSlug);
  if (!tenantParsed.success || !formParsed.success) return null;

  const form = await deps.findByPublicSlug(`${tenantParsed.data}/${formParsed.data}`);
  if (!form || !isFormServable(form) || !form.catalogue) return null;

  const catalogue = form.catalogue;
  const entity = await deps.findEntity(catalogue.entityDefId, form.tenantId);
  // A catalogue whose entity has been deleted shows nothing rather than
  // falling back to unlabelled data.
  if (!entity) return null;

  // The visitor may ask for fewer, never for more: the form's own page size
  // is the ceiling, and it was already capped when it was stored.
  const requested = typeof query.limit === "string" ? Number(query.limit) : query.limit;
  const limit =
    typeof requested === "number" && Number.isFinite(requested) && requested >= 1
      ? Math.min(Math.floor(requested), catalogue.pageSize)
      : catalogue.pageSize;

  const filter: Filter<RecordDoc> = {
    tenantId: form.tenantId,
    entityDefId: catalogue.entityDefId,
    deletedAt: null,
  };
  if (query.cursor) {
    // `decodeCursor` refuses anything this API did not issue, so a crafted
    // cursor is a 400 rather than an unbounded scan.
    filter._id = { $lt: new ObjectId(decodeCursor(query.cursor).id) };
  }

  // One extra row is how `hasMore` is known without a second count query.
  const rows = await deps.findRecords(filter, limit + 1);
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map((record) =>
    toCard(record, catalogue, new Map(entity.fields.map((f) => [f.key, f]))),
  );
  const last = items[items.length - 1];

  return {
    items,
    meta: {
      limit,
      hasMore,
      cursor: hasMore && last ? encodeCursor({ id: last.id }) : null,
    },
  };
}

/**
 * Whether a given record is currently on public display, and through which
 * field — the question `/api/v1/public/media/:mediaId` has to answer before
 * serving a record's photo to an anonymous visitor.
 *
 * Authorization runs owner-first, exactly as it does for a carousel image: the
 * image is public because a published, enabled form shows it, not because it
 * exists. Unpublishing the form, hitting its kill switch, turning catalogue
 * mode off, pointing `imageField` elsewhere or clearing the field all take the
 * photo down with them.
 */
export async function findCatalogueDisplayingRecord(
  record: RecordDoc & { _id: ObjectId },
  mediaId: string,
): Promise<boolean> {
  const db = await getDb();
  const forms = await db
    .collection<FormDoc>("forms")
    .find({
      tenantId: record.tenantId,
      deletedAt: null,
      published: true,
      enabled: true,
      "catalogue.entityDefId": record.entityDefId,
    } as Filter<FormDoc>)
    .toArray();

  return forms.some((form) => {
    const imageField = form.catalogue?.imageField;
    if (!imageField) return false;
    return record.data[imageField] === mediaId;
  });
}
