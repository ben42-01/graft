/**
 * The public catalogue — unit coverage.
 *
 * This is the product's first unauthenticated *read* of tenant data, so the
 * tests that matter are the ones that pin what a hostile visitor cannot do:
 * see a field nobody allowlisted, page past the server's cap, read a
 * soft-deleted record, or tell an unpublished form apart from one that never
 * existed. The happy path is the least interesting thing here.
 */
import { ObjectId, type WithId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import type { EntityDefDoc, FieldDef } from "./entities";
import type { FormDoc } from "./forms";
import type { RecordDoc } from "./records";
import {
  formatCardValue,
  getPublicCatalogue,
  toCard,
  type PublicCatalogueDeps,
} from "./public-catalogue";

const TENANT = "000000000000000000000001";
const FORM_ID = "000000000000000000000031";
const CATALOGUE_ENTITY = "000000000000000000000022";
const SUBMISSION_ENTITY = "000000000000000000000021";

const fields: FieldDef[] = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "price", label: "Price", type: "number", required: false },
  { key: "photo", label: "Photo", type: "image", required: false },
  { key: "cost_price", label: "Cost price", type: "number", required: false },
  { key: "available", label: "Available", type: "checkbox", required: false },
];

const seedForm = (over: Partial<WithId<FormDoc>> = {}): WithId<FormDoc> => ({
  _id: new ObjectId(FORM_ID),
  tenantId: new ObjectId(TENANT),
  entityDefId: new ObjectId(SUBMISSION_ENTITY),
  name: "Book a boat",
  slug: "book-a-boat",
  publicSlug: "harbour/book-a-boat",
  visibility: "public",
  published: true,
  enabled: true,
  killSwitchAt: null,
  killSwitchBy: null,
  fields: [fields[0]!],
  carousel: [],
  catalogue: {
    entityDefId: new ObjectId(CATALOGUE_ENTITY),
    fields: ["name", "price"],
    imageField: "photo",
    pageSize: 2,
    selectionKey: null,
  },
  showBadge: true,
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

const recordId = (n: number) => `0000000000000000000000${n.toString().padStart(2, "0")}`;

const seedRecord = (n: number, data: Record<string, unknown>): WithId<RecordDoc> => ({
  _id: new ObjectId(recordId(n)),
  tenantId: new ObjectId(TENANT),
  entityDefId: new ObjectId(CATALOGUE_ENTITY),
  schemaVersion: 1,
  data,
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

const seedEntity = (): WithId<EntityDefDoc> => ({
  _id: new ObjectId(CATALOGUE_ENTITY),
  tenantId: new ObjectId(TENANT),
  key: "rental_items",
  name: "Rental Items",
  fields,
  schemaVersion: 1,
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

function deps(
  form: WithId<FormDoc> | null,
  records: WithId<RecordDoc>[],
  over: Partial<PublicCatalogueDeps> = {},
) {
  const seen: { limit: number; filter: unknown }[] = [];
  return {
    seen,
    deps: {
      findByPublicSlug: vi.fn(async () => form),
      findEntity: vi.fn(async () => seedEntity()),
      findRecords: vi.fn(async (filter, limit) => {
        seen.push({ filter, limit });
        return records.slice(0, limit);
      }),
      ...over,
    } satisfies Partial<PublicCatalogueDeps>,
  };
}

describe("formatCardValue", () => {
  it("is total — every branch returns a string", () => {
    const text = fields[0]!;
    expect(formatCardValue(undefined, text)).toBe("");
    expect(formatCardValue(null, text)).toBe("");
    expect(formatCardValue("Pontoon", text)).toBe("Pontoon");
  });

  it("never stringifies an object onto a public page", () => {
    // Corrupt data on a text field renders as nothing, not "[object Object]".
    expect(formatCardValue({ nested: true }, fields[0]!)).toBe("");
    expect(formatCardValue(["a"], fields[0]!)).toBe("");
  });

  it("renders checkboxes and dates as a reader expects", () => {
    expect(formatCardValue(true, fields[4]!)).toBe("Yes");
    expect(formatCardValue(false, fields[4]!)).toBe("No");
    const date: FieldDef = { key: "d", label: "D", type: "date", required: false };
    expect(formatCardValue(new Date("2026-03-04T10:00:00Z"), date)).toBe("2026-03-04");
    expect(formatCardValue("not a date", date)).toBe("");
  });
});

describe("toCard", () => {
  const catalogue = seedForm().catalogue!;
  const byKey = new Map(fields.map((f) => [f.key, f]));

  it("projects only the allowlisted keys — never the rest of the record", () => {
    const card = toCard(
      seedRecord(1, { name: "Pontoon", price: 120, cost_price: 40, photo: recordId(9) }),
      catalogue,
      byKey,
    );

    expect(card.values.map((v) => v.key)).toEqual(["name", "price"]);
    expect(JSON.stringify(card)).not.toContain("40");
    expect(JSON.stringify(card)).not.toContain("cost_price");
  });

  it("resolves the image field to a URL, and to nothing when unset", () => {
    const withPhoto = toCard(
      seedRecord(1, { name: "Pontoon", photo: recordId(9) }),
      catalogue,
      byKey,
    );
    expect(withPhoto.image).toEqual({
      url: `/api/v1/public/media/${recordId(9)}`,
      alt: "Pontoon",
    });

    expect(toCard(seedRecord(2, { name: "Kayak" }), catalogue, byKey).image).toBeNull();
  });

  it("ignores a garbage image value rather than minting a bad URL", () => {
    const card = toCard(
      seedRecord(1, { name: "Pontoon", photo: "../../etc/passwd" }),
      catalogue,
      byKey,
    );
    expect(card.image).toBeNull();
  });

  it("skips an allowlisted key the entity no longer has", () => {
    const stale = { ...catalogue, fields: ["name", "removed_field"] };
    const card = toCard(seedRecord(1, { name: "Pontoon" }), stale, byKey);
    expect(card.values.map((v) => v.key)).toEqual(["name"]);
  });
});

describe("getPublicCatalogue", () => {
  it("serves a page of cards for a published catalogue form", async () => {
    const d = deps(seedForm(), [
      seedRecord(1, { name: "Pontoon", price: 120 }),
      seedRecord(2, { name: "Kayak", price: 40 }),
    ]);

    const page = await getPublicCatalogue("harbour", "book-a-boat", {}, d.deps);

    expect(page?.items.map((card) => card.values[0]!.value)).toEqual(["Pontoon", "Kayak"]);
    expect(page?.meta.hasMore).toBe(false);
  });

  it("excludes soft-deleted records — they are not merchandise", async () => {
    const d = deps(seedForm(), []);
    await getPublicCatalogue("harbour", "book-a-boat", {}, d.deps);
    expect(d.seen[0]!.filter).toMatchObject({ deletedAt: null });
  });

  it("clamps a visitor's limit to the form's own page size", async () => {
    const d = deps(seedForm(), []);
    await getPublicCatalogue("harbour", "book-a-boat", { limit: "500" }, d.deps);
    // pageSize is 2, so the over-fetch is 3 — never 501.
    expect(d.seen[0]!.limit).toBe(3);
  });

  it("honours a smaller limit than the page size", async () => {
    const d = deps(seedForm(), []);
    await getPublicCatalogue("harbour", "book-a-boat", { limit: "1" }, d.deps);
    expect(d.seen[0]!.limit).toBe(2);
  });

  it("falls back to the page size for a nonsense limit", async () => {
    const d = deps(seedForm(), []);
    await getPublicCatalogue("harbour", "book-a-boat", { limit: "nope" }, d.deps);
    expect(d.seen[0]!.limit).toBe(3);
  });

  it("refuses a cursor this API did not issue", async () => {
    const d = deps(seedForm(), []);
    await expect(
      getPublicCatalogue("harbour", "book-a-boat", { cursor: "../../etc" }, d.deps),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("pages with an opaque cursor when there is more", async () => {
    const d = deps(seedForm(), [
      seedRecord(1, { name: "A" }),
      seedRecord(2, { name: "B" }),
      seedRecord(3, { name: "C" }),
    ]);

    const page = await getPublicCatalogue("harbour", "book-a-boat", {}, d.deps);

    expect(page?.items).toHaveLength(2);
    expect(page?.meta.hasMore).toBe(true);
    expect(page?.meta.cursor).toBeTruthy();
    expect(page?.meta.cursor).not.toContain(recordId(2));
  });

  it("collapses unknown, unpublished, killed and not-a-catalogue into one null", async () => {
    for (const form of [
      null,
      seedForm({ published: false }),
      seedForm({ enabled: false }),
      seedForm({ catalogue: null }),
    ]) {
      const d = deps(form, [seedRecord(1, { name: "A" })]);
      expect(await getPublicCatalogue("harbour", "book-a-boat", {}, d.deps)).toBeNull();
    }
  });

  it("shows nothing rather than unlabelled data when the entity is gone", async () => {
    const d = deps(seedForm(), [seedRecord(1, { name: "A" })], {
      findEntity: vi.fn(async () => null),
    });
    expect(await getPublicCatalogue("harbour", "book-a-boat", {}, d.deps)).toBeNull();
  });

  it("rejects a malformed slug before it reaches the database", async () => {
    const d = deps(seedForm(), []);
    expect(await getPublicCatalogue("Harbour/../x", "book-a-boat", {}, d.deps)).toBeNull();
    expect(d.deps.findByPublicSlug).not.toHaveBeenCalled();
  });
});
