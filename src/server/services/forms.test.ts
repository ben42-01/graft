/**
 * Form Builder — unit coverage (GRAFT-08 AC1-AC7).
 *
 * Everything here runs against fake ports so the logic that matters — field
 * whitelisting, the public/internal quota split, the kill-switch precedence
 * rule, and slug collision handling — is exercised as pure logic. Persistence
 * and cross-tenant scoping are proven for real by bruno/forms/*.bru.
 */
import { MongoServerError, ObjectId, type WithId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import type { AccountStore, TenantRecord } from "@/server/auth/accounts-store";
import type { EntityView, FieldDef } from "@/server/services/entities";
import type { Meter, QuotaResult } from "@/server/services/meters";
import type { Repository } from "@/server/repositories/base";
import {
  attachFormImage,
  removeFormImage,
  requestFormImageUpload,
  updateFormCarousel,
  type FormMediaDeps,
} from "./form-media";
import {
  assertCanWriteForms,
  cartConfigErrors,
  createForm,
  deleteForm,
  getForm,
  isFormServable,
  listForms,
  isPaymentLinkUrl,
  paymentSchema,
  meterForVisibility,
  publicCartPricing,
  publishForm,
  resolveBooking,
  resolveCatalogue,
  resolveFormFields,
  toCatalogueView,
  unpublishForm,
  unpublishFormsForEntity,
  updateForm,
  updateFormSchema,
  type FormDoc,
} from "./forms";

const TENANT = "000000000000000000000001";
const USER = "00000000000000000000000b";
const ENTITY_ID = "000000000000000000000021";

const ctx: Ctx = createContext({
  requestId: "req-forms",
  tenantId: TENANT,
  userId: USER,
  roles: ["owner"],
  tier: "free",
});

const field = (over: Partial<FieldDef> = {}): FieldDef => ({
  key: "name",
  label: "Name",
  type: "text",
  required: true,
  ...over,
});

const entity = (over: Partial<EntityView> = {}): EntityView => ({
  id: ENTITY_ID,
  key: "customers",
  name: "Customers",
  fields: [field(), field({ key: "email", label: "Email", type: "email" })],
  schemaVersion: 1,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

const allowedQuota = (meter: Meter): QuotaResult => ({
  meter,
  period: "all",
  allowed: true,
  limit: 10,
  used: 1,
  remaining: 9,
  warned: false,
});

const refusedQuota = (meter: Meter): QuotaResult => ({
  meter,
  period: "all",
  allowed: false,
  limit: 10,
  used: 10,
  remaining: 0,
  reason: "quota_exceeded",
  warned: false,
});

/** A minimal in-memory stand-in for the repository port (base.ts). */
function fakeRepo(seed: (WithId<FormDoc> & { tenantId: ObjectId })[] = []) {
  const docs = new Map(seed.map((d) => [d._id.toHexString(), d]));
  const tenantId = new ObjectId(TENANT);

  const repo: Repository<FormDoc> = {
    collectionName: "forms",
    collection: vi.fn() as unknown as Repository<FormDoc>["collection"],

    async find(_ctx, filter) {
      const f = (filter ?? {}) as Record<string, unknown>;
      return [...docs.values()].filter(
        (d) =>
          d.tenantId.equals(tenantId) &&
          !d.deletedAt &&
          (f.entityDefId === undefined || d.entityDefId.equals(f.entityDefId as ObjectId)) &&
          (f.published === undefined || d.published === f.published),
      );
    },

    async findOne(_ctx, filter) {
      const f = (filter ?? {}) as Record<string, unknown>;
      return (
        [...docs.values()].find(
          (d) =>
            d.tenantId.equals(tenantId) &&
            !d.deletedAt &&
            (f.slug === undefined || d.slug === f.slug) &&
            (f._id === undefined || d._id.equals(f._id as ObjectId)),
        ) ?? null
      );
    },

    async findById(_ctx, id) {
      const found = docs.get(id.toString());
      return found && found.tenantId.equals(tenantId) && !found.deletedAt ? found : null;
    },

    async count() {
      return docs.size;
    },

    async insertOne(_ctx, doc) {
      // Mirrors the DB's partial unique index (scripts/create-indexes.ts):
      // scoped to live rows only, so a soft-deleted form frees its slug.
      const existing = [...docs.values()].find((d) => d.slug === doc.slug && !d.deletedAt);
      if (existing)
        throw new MongoServerError({ message: "E11000 duplicate key", code: 11000 });
      const full = {
        ...doc,
        tenantId,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as WithId<FormDoc>;
      const withId = { ...full, _id: new ObjectId() };
      docs.set(withId._id.toHexString(), withId);
      return withId;
    },

    async updateOne(_ctx, filter, update) {
      const target = [...docs.values()].find(
        (d) => d.tenantId.equals(tenantId) && d._id.equals((filter as { _id: ObjectId })._id),
      );
      if (!target) return null;
      const set = (update.$set ?? {}) as Partial<FormDoc>;
      if (set.publicSlug) {
        const collision = [...docs.values()].find(
          (d) => d._id.toString() !== target._id.toString() && d.publicSlug === set.publicSlug,
        );
        if (collision) {
          throw new MongoServerError({ message: "E11000 duplicate key", code: 11000 });
        }
      }
      const updated = { ...target, ...set, updatedAt: new Date() };
      docs.set(updated._id.toHexString(), updated);
      return updated;
    },

    async softDelete(_ctx, id) {
      const target = docs.get(id.toString());
      if (!target || !target.tenantId.equals(tenantId)) return false;
      docs.set(target._id.toHexString(), { ...target, deletedAt: new Date() });
      return true;
    },

    async listPage() {
      const items = [...docs.values()].filter(
        (d) => d.tenantId.equals(tenantId) && !d.deletedAt,
      );
      return { items, meta: { limit: 25, hasMore: false, cursor: null } };
    },
  };
  return { repo, docs };
}

const seedDoc = (
  over: Partial<WithId<FormDoc>> = {},
): WithId<FormDoc> & { tenantId: ObjectId } => ({
  _id: new ObjectId(),
  tenantId: new ObjectId(TENANT),
  entityDefId: new ObjectId(ENTITY_ID),
  name: "Booking Request",
  slug: "booking-request",
  publicSlug: null,
  visibility: "public",
  published: false,
  enabled: true,
  killSwitchAt: null,
  killSwitchBy: null,
  fields: [field()],
  showBadge: true,
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

const fakeAccounts = (tenant: TenantRecord): AccountStore =>
  ({
    findTenantById: vi.fn(async (id: string) => (id === TENANT ? tenant : null)),
  }) as unknown as AccountStore;

const TENANT_RECORD: TenantRecord = {
  id: TENANT,
  name: "QA Free Tenant",
  slug: "qa-free",
  tier: "free",
  limits: {} as TenantRecord["limits"],
  branding: null,
};

describe("resolveFormFields (AC1)", () => {
  it("copies the matching FieldDef for each requested key, in order", () => {
    const resolved = resolveFormFields([{ key: "email" }, { key: "name" }], entity().fields);
    expect(resolved.map((f) => f.key)).toEqual(["email", "name"]);
  });

  it("rejects a field the entity does not have, rather than inventing it", () => {
    expect(() => resolveFormFields([{ key: "ghost" }], entity().fields)).toThrow(AppError);
  });

  it("rejects a duplicate key in the request", () => {
    expect(() =>
      resolveFormFields([{ key: "name" }, { key: "name" }], entity().fields),
    ).toThrow(AppError);
  });
});

describe("meterForVisibility / quota split (AC4)", () => {
  it("charges internal_forms for internal forms and active_forms for public", () => {
    expect(meterForVisibility("internal")).toBe("internal_forms");
    expect(meterForVisibility("public")).toBe("active_forms");
  });

  it("createForm reserves internal_forms quota at creation for an internal form", async () => {
    const { repo } = fakeRepo([]);
    const consumeQuota = vi.fn(async (_c: Ctx, meter: Meter) => allowedQuota(meter));
    await createForm(
      ctx,
      {
        entityId: ENTITY_ID,
        name: "Staff Notes",
        slug: "staff-notes",
        visibility: "internal",
        fields: [{ key: "name" }],
      },
      { repo, getEntity: async () => entity(), consumeQuota },
    );
    expect(consumeQuota).toHaveBeenCalledWith(ctx, "internal_forms");
  });

  it("createForm reserves no quota for a public (unpublished) form", async () => {
    const { repo } = fakeRepo([]);
    const consumeQuota = vi.fn(async (_c: Ctx, meter: Meter) => allowedQuota(meter));
    await createForm(
      ctx,
      {
        entityId: ENTITY_ID,
        name: "Lead Capture",
        slug: "lead-capture",
        visibility: "public",
        fields: [{ key: "name" }],
      },
      { repo, getEntity: async () => entity(), consumeQuota },
    );
    expect(consumeQuota).not.toHaveBeenCalled();
  });

  it("publishForm reserves active_forms quota, and a refusal leaves the form unpublished (AC4)", async () => {
    const doc = seedDoc();
    const { repo, docs } = fakeRepo([doc]);
    // `consumeQuota` (the deps port here) throws on refusal, exactly like the
    // real src/server/services/meters.ts does — a plain refused-but-resolved
    // QuotaResult is what `checkQuota` returns, not `consumeQuota`.
    const consumeQuota = vi.fn(async (_c: Ctx, meter: Meter) => {
      const result = refusedQuota(meter);
      throw new AppError("QUOTA_EXCEEDED", "You have reached your plan's limit.", {
        meter: result.meter,
        limit: result.limit,
        used: result.used,
      });
    });
    await expect(
      publishForm(ctx, doc._id.toHexString(), {
        repo,
        accounts: fakeAccounts(TENANT_RECORD),
        consumeQuota,
      }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(docs.get(doc._id.toHexString())?.published).toBe(false);
  });
});

describe("isFormServable — kill-switch precedence (AC5)", () => {
  it("a published, enabled form is servable", () => {
    expect(isFormServable({ enabled: true, published: true })).toBe(true);
  });

  it("a killed form is never servable even when still published", () => {
    expect(isFormServable({ enabled: false, published: true })).toBe(false);
  });

  it("an unpublished form is not servable even when enabled", () => {
    expect(isFormServable({ enabled: true, published: false })).toBe(false);
  });

  it("updateForm timestamps and attributes a kill-switch flip", async () => {
    const doc = seedDoc({ enabled: true });
    const { repo, docs } = fakeRepo([doc]);
    await updateForm(ctx, doc._id.toHexString(), { enabled: false }, { repo });
    const updated = docs.get(doc._id.toHexString());
    expect(updated?.enabled).toBe(false);
    expect(updated?.killSwitchAt).not.toBeNull();
    expect(updated?.killSwitchBy?.toHexString()).toBe(USER);
  });

  it("leaves killSwitchAt untouched when enabled is not part of the patch", async () => {
    const doc = seedDoc({ enabled: true });
    const { repo, docs } = fakeRepo([doc]);
    await updateForm(ctx, doc._id.toHexString(), { name: "Renamed" }, { repo });
    expect(docs.get(doc._id.toHexString())?.killSwitchAt).toBeNull();
  });
});

describe("publishForm — slug generation and collision handling (AC2)", () => {
  it("assigns publicSlug as tenantSlug/formSlug", async () => {
    const doc = seedDoc();
    const { repo, docs } = fakeRepo([doc]);
    const form = await publishForm(ctx, doc._id.toHexString(), {
      repo,
      accounts: fakeAccounts(TENANT_RECORD),
      consumeQuota: async (_c, meter) => allowedQuota(meter),
    });
    expect(form.publicSlug).toBe("qa-free/booking-request");
    expect(docs.get(doc._id.toHexString())?.published).toBe(true);
  });

  it("a publicSlug collision is refused with 409 and nothing is published", async () => {
    const taken = seedDoc({
      _id: new ObjectId(),
      slug: "booking-request",
      publicSlug: "qa-free/booking-request",
      published: true,
    });
    const other = seedDoc({ slug: "booking-request-2" });
    // Force a collision by publishing `other` to the same publicSlug the fake
    // repo already holds for `taken` — the fake repo's updateOne enforces the
    // same uniqueness a real partial unique index would.
    const { repo, docs } = fakeRepo([taken, other]);
    docs.set(other._id.toHexString(), { ...other, slug: "booking-request" });
    await expect(
      publishForm(ctx, other._id.toHexString(), {
        repo,
        accounts: fakeAccounts(TENANT_RECORD),
        consumeQuota: async (_c, meter) => allowedQuota(meter),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(docs.get(other._id.toHexString())?.published).toBe(false);
  });

  it("refuses to publish an internal form", async () => {
    const doc = seedDoc({ visibility: "internal" });
    const { repo } = fakeRepo([doc]);
    await expect(
      publishForm(ctx, doc._id.toHexString(), {
        repo,
        accounts: fakeAccounts(TENANT_RECORD),
        consumeQuota: async (_c, meter) => allowedQuota(meter),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("is idempotent — publishing an already-published form does not re-charge quota", async () => {
    const doc = seedDoc({ published: true, publicSlug: "qa-free/booking-request" });
    const { repo } = fakeRepo([doc]);
    const consumeQuota = vi.fn(async (_c: Ctx, meter: Meter) => allowedQuota(meter));
    await publishForm(ctx, doc._id.toHexString(), {
      repo,
      accounts: fakeAccounts(TENANT_RECORD),
      consumeQuota,
    });
    expect(consumeQuota).not.toHaveBeenCalled();
  });
});

describe("unpublishForm (AC3)", () => {
  it("clears publicSlug and published, keeping the definition", async () => {
    const doc = seedDoc({ published: true, publicSlug: "qa-free/booking-request" });
    const { repo, docs } = fakeRepo([doc]);
    const form = await unpublishForm(ctx, doc._id.toHexString(), { repo });
    expect(form.published).toBe(false);
    expect(form.publicSlug).toBeNull();
    expect(docs.get(doc._id.toHexString())?.name).toBe("Booking Request");
  });
});

describe("unpublishFormsForEntity (AC7)", () => {
  it("unpublishes every published form bound to the entity, leaving others alone", async () => {
    const bound = seedDoc({ published: true, publicSlug: "qa-free/booking-request" });
    const unrelated = seedDoc({
      _id: new ObjectId(),
      entityDefId: new ObjectId(),
      slug: "other",
      published: true,
      publicSlug: "qa-free/other",
    });
    const { repo, docs } = fakeRepo([bound, unrelated]);
    await unpublishFormsForEntity(ctx, ENTITY_ID, { repo });
    expect(docs.get(bound._id.toHexString())?.published).toBe(false);
    expect(docs.get(bound._id.toHexString())?.publicSlug).toBeNull();
    expect(docs.get(unrelated._id.toHexString())?.published).toBe(true);
  });
});

describe("createForm — slug collision (AC1)", () => {
  it("returns CONFLICT when the tenant already has a form at that slug", async () => {
    const existing = seedDoc();
    const { repo } = fakeRepo([existing]);
    await expect(
      createForm(
        ctx,
        {
          entityId: ENTITY_ID,
          name: "Duplicate",
          slug: existing.slug,
          visibility: "public",
          fields: [{ key: "name" }],
        },
        { repo, getEntity: async () => entity() },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("lets a slug be reused once the form at it is soft-deleted", async () => {
    const existing = seedDoc();
    const { repo, docs } = fakeRepo([existing]);

    await deleteForm(ctx, existing._id.toHexString(), { repo });
    expect(docs.get(existing._id.toHexString())?.deletedAt).not.toBeNull();

    const recreated = await createForm(
      ctx,
      {
        entityId: ENTITY_ID,
        name: "Hotel Rooms (retry)",
        slug: existing.slug,
        visibility: "public",
        fields: [{ key: "name" }],
      },
      { repo, getEntity: async () => entity() },
    );
    expect(recreated.slug).toBe(existing.slug);
  });
});

/**
 * Catalogue mode. The rule under test throughout is that the two key lists
 * are checked against two *different* entities: `fields`/`imageField` describe
 * the records a visitor browses, `selectionKey` describes where their choice
 * lands on the way back in. Validating both against one schema is the bug
 * this signature exists to prevent.
 */
describe("resolveCatalogue", () => {
  const browse: FieldDef[] = [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "photo", label: "Photo", type: "image", required: false },
    { key: "cost", label: "Cost", type: "number", required: false },
  ];
  const submit: FieldDef[] = [
    { key: "customer", label: "Customer", type: "text", required: true },
    { key: "chosen_item", label: "Chosen item", type: "text", required: false },
    { key: "when", label: "When", type: "date", required: false },
  ];

  const SUBMIT_ENTITY_ID = "000000000000000000000099";

  const input = (over: Record<string, unknown> = {}) => ({
    entityId: "000000000000000000000022",
    fields: ["name"],
    imageField: "photo" as string | null,
    pageSize: 12,
    selectionKey: null as string | null,
    multiple: false,
    ...over,
  });

  it("stores the resolved config, with the entity id as an ObjectId", () => {
    const config = resolveCatalogue(input(), browse, submit, SUBMIT_ENTITY_ID);
    expect(config.entityDefId.toHexString()).toBe("000000000000000000000022");
    expect(config.fields).toEqual(["name"]);
    expect(config.imageField).toBe("photo");
  });

  /** The reason is in the error's field details, not its message — that is
   * what the client renders beside the offending input. */
  const reasonFor = (over: Record<string, unknown>): string => {
    try {
      resolveCatalogue(input(over), browse, submit, SUBMIT_ENTITY_ID);
    } catch (error) {
      const details = (error as AppError).details as
        { fields?: Record<string, string> } | undefined;
      return details?.fields?.catalogue ?? "";
    }
    throw new Error("expected resolveCatalogue to throw");
  };

  it("refuses a browse field that is not on the catalogue entity", () => {
    expect(() =>
      resolveCatalogue(input({ fields: ["nope"] }), browse, submit, SUBMIT_ENTITY_ID),
    ).toThrow(AppError);
    expect(reasonFor({ fields: ["nope"] })).toMatch(
      /Unknown field "nope" on the catalogue entity/,
    );
  });

  it("refuses the same browse field twice", () => {
    expect(reasonFor({ fields: ["name", "name"] })).toMatch(/Duplicate field/);
  });

  it("refuses an image field that does not hold an image", () => {
    expect(reasonFor({ imageField: "cost" })).toMatch(/does not hold an image/);
  });

  it("checks selectionKey against the form's own entity, not the catalogue's", () => {
    // "name" exists on the *browse* entity and must still be refused here.
    expect(reasonFor({ selectionKey: "name" })).toMatch(
      /Unknown field "name" on the form's own entity/,
    );
    expect(
      resolveCatalogue(input({ selectionKey: "chosen_item" }), browse, submit, SUBMIT_ENTITY_ID)
        .selectionKey,
    ).toBe("chosen_item");
  });

  it("refuses a selectionKey that could not hold a record id", () => {
    expect(reasonFor({ selectionKey: "when" })).toMatch(/must be a text field/);
  });

  it("allows a catalogue with no image and no selection — a plain gallery", () => {
    const config = resolveCatalogue(
      input({ fields: [], imageField: null, selectionKey: null }),
      browse,
      submit,
      SUBMIT_ENTITY_ID,
    );
    expect(config).toMatchObject({ fields: [], imageField: null, selectionKey: null });
  });

  it("refuses a catalogue that browses the same entity the form submits to", () => {
    // The exact "Hotel Rooms" bug report: pick one entity for both roles and
    // every catalogue display field (with its picture) doubles as a field the
    // customer must also fill in — and browsing would read other visitors'
    // own submissions.
    expect(() =>
      resolveCatalogue(input({ entityId: SUBMIT_ENTITY_ID }), browse, submit, SUBMIT_ENTITY_ID),
    ).toThrow(AppError);
    expect(reasonFor({ entityId: SUBMIT_ENTITY_ID })).toMatch(/must browse a different entity/);
  });
});

/**
 * Booking mode. The rule under test throughout is that a config is resolved
 * against the form's *own* fields and against a catalogue that can actually
 * name a resource — the submit path relies on both having been checked here,
 * because it has no authenticated user to report a misconfiguration to.
 */
describe("resolveBooking", () => {
  const formFields: FieldDef[] = [
    { key: "customer", label: "Customer", type: "text", required: true },
    { key: "starts_at", label: "Starts", type: "date", required: true },
    { key: "ends_at", label: "Ends", type: "date", required: true },
    { key: "people", label: "People", type: "number", required: false },
  ];

  const catalogue = (selectionKey: string | null = "chosen_item") => ({
    entityDefId: new ObjectId("000000000000000000000022"),
    fields: [],
    imageField: null,
    pageSize: 12,
    selectionKey,
  });

  const input = (over: Record<string, unknown> = {}) => ({
    startKey: "starts_at",
    endKey: "ends_at" as string | null,
    durationMinutes: null as number | null,
    quantityKey: null as string | null,
    rateBasis: "hourly" as const,
    rateKey: null as string | null,
    labelKey: null as string | null,
    depositPercent: null as number | null,
    ...over,
  });

  /** The catalogue entity — what `rateKey` and `labelKey` are checked against. */
  const resourceFields: FieldDef[] = [
    { key: "boat_name", label: "Boat", type: "text", required: true },
    { key: "price_per_hour", label: "Price", type: "number", required: false },
    { key: "moored_at", label: "Moored at", type: "text", required: false },
  ];

  it("resolves a complete config unchanged", () => {
    expect(resolveBooking(input(), formFields, catalogue())).toEqual({
      startKey: "starts_at",
      endKey: "ends_at",
      durationMinutes: null,
      quantityKey: null,
      rateBasis: "hourly",
      rateKey: null,
      labelKey: null,
      depositPercent: null,
    });
  });

  it("resolves rate and label mappings against the catalogue entity", () => {
    expect(
      resolveBooking(
        input({ rateKey: "price_per_hour", labelKey: "boat_name" }),
        formFields,
        catalogue(),
        resourceFields,
      ),
    ).toMatchObject({ rateKey: "price_per_hour", labelKey: "boat_name" });
  });

  it("refuses a rate key that is not on the catalogue entity", () => {
    // "people" is a number field on the *form*, which is the mistake this
    // check exists to catch: the rate lives on the thing being booked.
    expect(() =>
      resolveBooking(input({ rateKey: "people" }), formFields, catalogue(), resourceFields),
    ).toThrow(AppError);
  });

  it("refuses a rate key that is not a number, and a label key that is not text", () => {
    expect(() =>
      resolveBooking(input({ rateKey: "boat_name" }), formFields, catalogue(), resourceFields),
    ).toThrow(AppError);
    expect(() =>
      resolveBooking(
        input({ labelKey: "price_per_hour" }),
        formFields,
        catalogue(),
        resourceFields,
      ),
    ).toThrow(AppError);
  });

  it("refuses booking mode without a catalogue — there is nothing to book", () => {
    expect(() => resolveBooking(input(), formFields, null)).toThrow(AppError);
  });

  it("refuses a catalogue that records no selection", () => {
    expect(() => resolveBooking(input(), formFields, catalogue(null))).toThrow(AppError);
  });

  it("refuses a start key that is not a field on this form", () => {
    expect(() => resolveBooking(input({ startKey: "nope" }), formFields, catalogue())).toThrow(
      AppError,
    );
  });

  it("refuses a start key that is not a date field", () => {
    expect(() =>
      resolveBooking(input({ startKey: "customer" }), formFields, catalogue()),
    ).toThrow(AppError);
  });

  it("refuses the same field as both start and end", () => {
    expect(() =>
      resolveBooking(input({ endKey: "starts_at" }), formFields, catalogue()),
    ).toThrow(AppError);
  });

  it("refuses a quantity key that is not a number field", () => {
    expect(() =>
      resolveBooking(input({ quantityKey: "customer" }), formFields, catalogue()),
    ).toThrow(AppError);
  });

  it("accepts a fixed-duration form with no end field", () => {
    expect(
      resolveBooking(input({ endKey: null, durationMinutes: 90 }), formFields, catalogue()),
    ).toMatchObject({ endKey: null, durationMinutes: 90 });
  });
});

/**
 * GRAFT-24 — payment links. The rule under test is an allow-list on the
 * *parsed* URL: Graft sends an unauthenticated visitor wherever this string
 * points, so anything that is not demonstrably a Stripe payment link is a
 * validation failure rather than a redirect.
 */
describe("isPaymentLinkUrl (GRAFT-24 AC3)", () => {
  it("accepts an https buy.stripe.com link", () => {
    expect(isPaymentLinkUrl("https://buy.stripe.com/abc")).toBe(true);
  });

  it("accepts one that already carries query parameters", () => {
    expect(isPaymentLinkUrl("https://buy.stripe.com/abc?prefilled_email=x")).toBe(true);
  });

  it.each([
    ["http (not https)", "http://buy.stripe.com/x"],
    ["an unrelated host", "https://evil.test/x"],
    ["a suffix attack on the host", "https://buy.stripe.com.evil.test/x"],
    ["a prefix attack on the host", "https://evilbuy.stripe.com/x"],
    ["the host smuggled into a query string", "https://evil.test/?x=buy.stripe.com"],
    ["the host smuggled into a path", "https://evil.test/buy.stripe.com"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a protocol-relative URL", "//buy.stripe.com/x"],
    ["a userinfo trick", "https://buy.stripe.com@evil.test/x"],
    ["a subdomain of the allowed host", "https://a.buy.stripe.com/x"],
    ["the empty string", ""],
    ["whitespace only", "   "],
    ["a bare host with no scheme", "buy.stripe.com/x"],
  ])("rejects %s", (_label, value) => {
    expect(isPaymentLinkUrl(value)).toBe(false);
  });
});

describe("paymentSchema (GRAFT-24 AC1, AC2, AC3)", () => {
  const input = (over: Record<string, unknown> = {}) => ({
    mode: "link",
    link: { url: "https://buy.stripe.com/abc" },
    required: true,
    ...over,
  });

  it("accepts a link-mode config", () => {
    const parsed = paymentSchema.parse(input());
    expect(parsed).toEqual({
      mode: "link",
      link: { url: "https://buy.stripe.com/abc" },
      required: true,
    });
  });

  it("AC2 — refuses keys mode, which does not exist yet", () => {
    expect(paymentSchema.safeParse(input({ mode: "keys" })).success).toBe(false);
  });

  it("AC2 — refuses any other mode", () => {
    expect(paymentSchema.safeParse(input({ mode: "invoice" })).success).toBe(false);
  });

  it("AC3 — refuses a URL that is not a Stripe payment link", () => {
    expect(
      paymentSchema.safeParse(input({ link: { url: "https://evil.test/x" } })).success,
    ).toBe(false);
  });

  it("defaults `required` to false when it is not given", () => {
    const parsed = paymentSchema.parse({
      mode: "link",
      link: { url: "https://buy.stripe.com/a" },
    });
    expect(parsed).toMatchObject({ required: false });
  });
  it("accepts checkout mode, which carries no URL and no amount", () => {
    expect(paymentSchema.parse({ mode: "checkout", required: true })).toEqual({
      mode: "checkout",
      required: true,
    });
  });

  it("drops an amount a caller tries to store on checkout mode — the order prices it", () => {
    const parsed = paymentSchema.parse({ mode: "checkout", amountMinor: 1 });
    expect(parsed).toEqual({ mode: "checkout", required: false });
  });

  it("accepts manual mode, trimming the instructions and defaulting them to empty", () => {
    expect(
      paymentSchema.parse({ mode: "manual", instructions: "  Pay by bank transfer.  " }),
    ).toEqual({ mode: "manual", instructions: "Pay by bank transfer." });
    expect(paymentSchema.parse({ mode: "manual" })).toEqual({
      mode: "manual",
      instructions: "",
    });
  });

  it("drops a URL or redirect flag sent with manual mode — nothing is redirected", () => {
    expect(
      paymentSchema.parse({
        mode: "manual",
        link: { url: "https://buy.stripe.com/a" },
        required: true,
      }),
    ).toEqual({ mode: "manual", instructions: "" });
  });

  it("refuses manual instructions longer than the cap", () => {
    expect(
      paymentSchema.safeParse({ mode: "manual", instructions: "x".repeat(1_001) }).success,
    ).toBe(false);
  });

  it("has no mode that takes Stripe API keys", () => {
    expect(paymentSchema.safeParse({ mode: "keys", secretKey: "sk_test_x" }).success).toBe(
      false,
    );
  });
});

describe("createForm / updateForm — the payment block (GRAFT-24 AC1)", () => {
  const payment = {
    mode: "link" as const,
    link: { url: "https://buy.stripe.com/abc" },
    required: true,
  };

  it("AC1 — a form created without `payment` has payment: null", async () => {
    const { repo } = fakeRepo();
    const view = await createForm(
      ctx,
      {
        entityId: ENTITY_ID,
        name: "Contact",
        slug: "contact",
        visibility: "public",
        fields: [{ key: "name" }],
      },
      { repo, getEntity: async () => entity() },
    );
    expect(view.payment).toBeNull();
  });

  it("AC1 — a form created with `payment` keeps it", async () => {
    const { repo } = fakeRepo();
    const view = await createForm(
      ctx,
      {
        entityId: ENTITY_ID,
        name: "Hire",
        slug: "hire",
        visibility: "public",
        fields: [{ key: "name" }],
        payment,
      },
      { repo, getEntity: async () => entity() },
    );
    expect(view.payment).toEqual(payment);
  });

  it("AC1, AC11 — a PATCH sets it, and an explicit null turns it off", async () => {
    const existing = seedDoc();
    const { repo } = fakeRepo([existing]);
    const on = await updateForm(ctx, existing._id.toHexString(), { payment }, { repo });
    expect(on.payment).toEqual(payment);

    const off = await updateForm(ctx, existing._id.toHexString(), { payment: null }, { repo });
    expect(off.payment).toBeNull();
  });

  it('AC1 — `payment` alone satisfies the "Nothing to update" refinement', () => {
    expect(updateFormSchema.safeParse({ payment: null }).success).toBe(true);
    expect(updateFormSchema.safeParse({}).success).toBe(false);
  });

  it("AC3 — a PATCH carrying a hostile URL is a validation failure", async () => {
    const existing = seedDoc();
    const { repo } = fakeRepo([existing]);
    await expect(
      updateForm(
        ctx,
        existing._id.toHexString(),
        { payment: { ...payment, link: { url: "https://buy.stripe.com.evil.test/x" } } },
        { repo },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("AC12 — another tenant's form is not found, so no payment is written or read", async () => {
    const otherTenant = seedDoc({ tenantId: new ObjectId("0000000000000000000000ff") });
    const { repo } = fakeRepo([otherTenant]);
    await expect(
      updateForm(ctx, otherTenant._id.toHexString(), { payment }, { repo }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("createForm / updateForm — notes and links for customers", () => {
  const notice = {
    id: "policy",
    kind: "notice" as const,
    title: "Cancellation policy",
    body: "Cancel up to 24 hours before for a full refund.",
    after: null,
  };
  const link = (after: string | null) => ({
    id: "terms",
    kind: "link" as const,
    label: "Terms of hire",
    url: "https://example.com/terms",
    requireAgreement: true,
    after,
  });

  it("a form created without content has none", async () => {
    const { repo } = fakeRepo();
    const view = await createForm(
      ctx,
      {
        entityId: ENTITY_ID,
        name: "Contact",
        slug: "contact",
        visibility: "public",
        fields: [{ key: "name" }],
      },
      { repo, getEntity: async () => entity() },
    );
    expect(view.content).toEqual([]);
  });

  it("stores blocks in order, each placed at the top or after a field the form collects", async () => {
    const existing = seedDoc();
    const { repo } = fakeRepo([existing]);
    const afterKey = existing.fields[0]!.key;

    const view = await updateForm(
      ctx,
      existing._id.toHexString(),
      { content: [notice, link(afterKey)] },
      { repo },
    );

    expect(view.content).toEqual([notice, link(afterKey)]);
  });

  it("an empty list removes every block", async () => {
    const existing = seedDoc({ content: [notice] });
    const { repo } = fakeRepo([existing]);
    const view = await updateForm(ctx, existing._id.toHexString(), { content: [] }, { repo });
    expect(view.content).toEqual([]);
  });

  it("refuses a block placed after a field the form does not collect", async () => {
    const existing = seedDoc();
    const { repo } = fakeRepo([existing]);
    await expect(
      updateForm(ctx, existing._id.toHexString(), { content: [link("not_on_form")] }, { repo }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fields: { content: expect.stringContaining("not_on_form") } },
    });
  });

  it("refuses a link that is not an http(s) web address", async () => {
    const existing = seedDoc();
    const { repo } = fakeRepo([existing]);
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "https://user:pw@example.com",
    ]) {
      await expect(
        updateForm(
          ctx,
          existing._id.toHexString(),
          { content: [{ ...link(null), url }] },
          { repo },
        ),
        url,
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
  });

  it("refuses two blocks with the same id, and a message with no text", async () => {
    const existing = seedDoc();
    const { repo } = fakeRepo([existing]);
    await expect(
      updateForm(
        ctx,
        existing._id.toHexString(),
        { content: [notice, { ...notice }] },
        { repo },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      updateForm(
        ctx,
        existing._id.toHexString(),
        { content: [{ ...notice, body: "   " }] },
        { repo },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it('`content` alone satisfies the "Nothing to update" refinement', () => {
    expect(updateFormSchema.safeParse({ content: [] }).success).toBe(true);
  });
});

/**
 * GRAFT-30.1 — cart mode (`catalogue.multiple`). The switch itself, its three
 * rules on create and update, and the public pricing hint. The rules are
 * checked against the state a write leaves behind, so the update cases below
 * each touch only one part of a form that is already in cart mode.
 */
describe("catalogue.multiple — cart mode (GRAFT-30.1)", () => {
  const CATALOGUE_ENTITY_ID = "000000000000000000000022";

  const submissionEntity = entity({
    fields: [
      field({ key: "customer", label: "Customer" }),
      field({ key: "chosen_item", label: "Chosen item", required: false }),
      field({ key: "starts_at", label: "Starts", type: "date" }),
      field({ key: "ends_at", label: "Ends", type: "date" }),
      field({ key: "people", label: "People", type: "number", required: false }),
    ],
  });
  const catalogueEntity = entity({
    id: CATALOGUE_ENTITY_ID,
    key: "items",
    name: "Items",
    fields: [
      field({ key: "item_name", label: "Item" }),
      field({ key: "price", label: "Price", type: "number", required: false }),
      field({ key: "cost", label: "Cost", type: "number", required: false }),
    ],
  });
  const getEntity = async (_ctx: Ctx, id: string) =>
    id === CATALOGUE_ENTITY_ID ? catalogueEntity : submissionEntity;

  const catalogueInput = (multiple?: boolean) => ({
    entityId: CATALOGUE_ENTITY_ID,
    fields: ["item_name", "price"],
    selectionKey: "chosen_item",
    ...(multiple === undefined ? {} : { multiple }),
  });
  const bookingInput = (over: Record<string, unknown> = {}) => ({
    startKey: "starts_at",
    endKey: "ends_at",
    rateBasis: "daily",
    rateKey: "price",
    ...over,
  });
  const linkPayment = { mode: "link", link: { url: "https://buy.stripe.com/abc" } };

  const createInput = (over: Record<string, unknown> = {}) => ({
    entityId: ENTITY_ID,
    name: "Shop",
    slug: "shop",
    visibility: "public",
    fields: [
      { key: "customer" },
      { key: "chosen_item" },
      { key: "starts_at" },
      { key: "ends_at" },
    ],
    ...over,
  });

  /** The stored shape of a form already in cart mode. */
  const cartDoc = () =>
    seedDoc({
      fields: submissionEntity.fields,
      catalogue: {
        entityDefId: new ObjectId(CATALOGUE_ENTITY_ID),
        fields: ["item_name", "price"],
        imageField: null,
        pageSize: 12,
        selectionKey: "chosen_item",
        multiple: true,
      },
      booking: {
        startKey: "starts_at",
        endKey: "ends_at",
        durationMinutes: null,
        quantityKey: null,
        rateBasis: "daily",
        rateKey: "price",
        labelKey: null,
        depositPercent: null,
      },
      payment: null,
    });

  /** The field errors a refusal carries — what the builder renders. */
  async function refusal(promise: Promise<unknown>): Promise<Record<string, string>> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION_FAILED");
      return ((error as AppError).details as { fields: Record<string, string> }).fields;
    }
    throw new Error("expected the write to be refused");
  }

  it("AC1 — a form created without `multiple` reads multiple: false", async () => {
    const { repo } = fakeRepo();
    const view = await createForm(ctx, createInput({ catalogue: catalogueInput() }), {
      repo,
      getEntity,
    });
    expect(view.catalogue?.multiple).toBe(false);
  });

  it("AC1 — a catalogue stored before the switch existed reads false, no migration", async () => {
    const legacy = seedDoc({
      catalogue: {
        entityDefId: new ObjectId(CATALOGUE_ENTITY_ID),
        fields: ["item_name"],
        imageField: null,
        pageSize: 12,
        selectionKey: null,
      },
    });
    expect(toCatalogueView(legacy.catalogue)?.multiple).toBe(false);
    const { repo } = fakeRepo([legacy]);
    const read = await updateForm(ctx, legacy._id.toHexString(), { name: "Renamed" }, { repo });
    expect(read.catalogue?.multiple).toBe(false);
  });

  it("AC2 — an owner turns it on for a form with a selection and a booking config", async () => {
    const existing = cartDoc();
    existing.catalogue = { ...existing.catalogue!, multiple: false };
    const { repo, docs } = fakeRepo([existing]);
    const view = await updateForm(
      ctx,
      existing._id.toHexString(),
      { catalogue: catalogueInput(true) },
      { repo, getEntity },
    );
    expect(view.catalogue?.multiple).toBe(true);
    expect(docs.get(existing._id.toHexString())?.catalogue?.multiple).toBe(true);
  });

  it("AC2 — created in cart mode with a booking config and Checkout", async () => {
    const { repo } = fakeRepo();
    const view = await createForm(
      ctx,
      createInput({
        catalogue: catalogueInput(true),
        booking: bookingInput(),
        payment: { mode: "checkout" },
      }),
      { repo, getEntity },
    );
    expect(view.catalogue?.multiple).toBe(true);
    expect(view.payment).toEqual({ mode: "checkout", required: false });
  });

  it("AC3 — create: cart mode with no booking config is refused on catalogue.multiple", async () => {
    const { repo, docs } = fakeRepo();
    const fields = await refusal(
      createForm(ctx, createInput({ catalogue: catalogueInput(true) }), { repo, getEntity }),
    );
    expect(Object.keys(fields)).toEqual(["catalogue.multiple"]);
    expect(docs.size).toBe(0);
  });

  it("AC4 — create: a form-level quantityKey is refused on booking.quantityKey", async () => {
    const { repo, docs } = fakeRepo();
    const fields = await refusal(
      createForm(
        ctx,
        createInput({
          fields: [...createInput().fields, { key: "people" }],
          catalogue: catalogueInput(true),
          booking: bookingInput({ quantityKey: "people" }),
        }),
        { repo, getEntity },
      ),
    );
    expect(Object.keys(fields)).toEqual(["booking.quantityKey"]);
    expect(docs.size).toBe(0);
  });

  it("AC5 — create: a payment link is refused on payment", async () => {
    const { repo, docs } = fakeRepo();
    const fields = await refusal(
      createForm(
        ctx,
        createInput({
          catalogue: catalogueInput(true),
          booking: bookingInput(),
          payment: linkPayment,
        }),
        { repo, getEntity },
      ),
    );
    expect(Object.keys(fields)).toEqual(["payment"]);
    expect(docs.size).toBe(0);
  });

  it("AC5 — create: no payment at all is accepted", async () => {
    const { repo } = fakeRepo();
    const view = await createForm(
      ctx,
      createInput({ catalogue: catalogueInput(true), booking: bookingInput() }),
      { repo, getEntity },
    );
    expect(view.payment).toBeNull();
  });

  it("AC3 — update: turning it on for a form with no booking config is refused", async () => {
    const existing = cartDoc();
    existing.catalogue = { ...existing.catalogue!, multiple: false };
    existing.booking = null;
    const { repo, docs } = fakeRepo([existing]);
    const fields = await refusal(
      updateForm(
        ctx,
        existing._id.toHexString(),
        { catalogue: catalogueInput(true) },
        {
          repo,
          getEntity,
        },
      ),
    );
    expect(fields).toHaveProperty("catalogue.multiple");
    expect(docs.get(existing._id.toHexString())?.catalogue?.multiple).toBe(false);
  });

  it("AC6 — update touching only booking: removing it is refused, nothing written", async () => {
    const existing = cartDoc();
    const { repo, docs } = fakeRepo([existing]);
    const fields = await refusal(
      updateForm(ctx, existing._id.toHexString(), { booking: null }, { repo, getEntity }),
    );
    expect(Object.keys(fields)).toEqual(["catalogue.multiple"]);
    expect(docs.get(existing._id.toHexString())).toBe(existing);
  });

  it("AC6 — update touching only booking: adding a quantityKey is refused, nothing written", async () => {
    const existing = cartDoc();
    const { repo, docs } = fakeRepo([existing]);
    const fields = await refusal(
      updateForm(
        ctx,
        existing._id.toHexString(),
        { booking: bookingInput({ quantityKey: "people" }) },
        { repo, getEntity },
      ),
    );
    expect(Object.keys(fields)).toEqual(["booking.quantityKey"]);
    expect(docs.get(existing._id.toHexString())).toBe(existing);
  });

  it("AC6 — update touching only payment: switching to a link is refused, nothing written", async () => {
    const existing = cartDoc();
    const { repo, docs } = fakeRepo([existing]);
    const fields = await refusal(
      updateForm(
        ctx,
        existing._id.toHexString(),
        { payment: linkPayment },
        { repo, getEntity },
      ),
    );
    expect(Object.keys(fields)).toEqual(["payment"]);
    expect(docs.get(existing._id.toHexString())).toBe(existing);
  });

  it("AC5, AC6 — Checkout is accepted on a cart form", async () => {
    const existing = cartDoc();
    const { repo } = fakeRepo([existing]);
    const view = await updateForm(
      ctx,
      existing._id.toHexString(),
      { payment: { mode: "checkout", required: true } },
      { repo, getEntity },
    );
    expect(view.payment).toEqual({ mode: "checkout", required: true });
  });

  it("AC6 — turning multiple off in the same call makes a payment link legal again", async () => {
    const existing = cartDoc();
    const { repo } = fakeRepo([existing]);
    const view = await updateForm(
      ctx,
      existing._id.toHexString(),
      { catalogue: catalogueInput(false), payment: linkPayment },
      { repo, getEntity },
    );
    expect(view.catalogue?.multiple).toBe(false);
    expect(view.payment?.mode).toBe("link");
  });

  it("AC8 — another tenant's form is not found and stays unchanged", async () => {
    const other = cartDoc();
    other.tenantId = new ObjectId("0000000000000000000000ff");
    other.catalogue = { ...other.catalogue!, multiple: false };
    const { repo, docs } = fakeRepo([other]);
    await expect(
      updateForm(
        ctx,
        other._id.toHexString(),
        { catalogue: catalogueInput(true) },
        {
          repo,
          getEntity,
        },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(docs.get(other._id.toHexString())).toBe(other);
  });

  describe("cartConfigErrors", () => {
    const booking = { quantityKey: null };

    it("has nothing to say about a form that is not in cart mode", () => {
      expect(cartConfigErrors(null, null, null)).toEqual({});
      expect(
        cartConfigErrors({ multiple: false }, null, {
          mode: "link",
          link: { url: "https://buy.stripe.com/x" },
          required: false,
        }),
      ).toEqual({});
      expect(cartConfigErrors({}, null, null)).toEqual({});
    });

    it("reports every broken rule at once", () => {
      expect(
        Object.keys(
          cartConfigErrors({ multiple: true }, null, {
            mode: "link",
            link: { url: "https://buy.stripe.com/x" },
            required: false,
          }),
        ),
      ).toEqual(["catalogue.multiple", "payment"]);
    });

    it("accepts a booking with no quantity and Checkout, manual or no payment", () => {
      expect(cartConfigErrors({ multiple: true }, booking, null)).toEqual({});
      expect(
        cartConfigErrors({ multiple: true }, booking, { mode: "checkout", required: false }),
      ).toEqual({});
      expect(
        cartConfigErrors({ multiple: true }, booking, { mode: "manual", instructions: "" }),
      ).toEqual({});
    });
  });

  describe("publicCartPricing (AC7)", () => {
    const catalogue = { fields: ["item_name", "price"], multiple: true };
    const booking = { rateBasis: "daily" as const, rateKey: "price" as string | null };

    it("exposes the rate basis and key when the key is already a public catalogue field", () => {
      expect(publicCartPricing(catalogue, booking)).toEqual({
        rateBasis: "daily",
        rateKey: "price",
      });
    });

    it("is null when the rate key is not on the public allowlist", () => {
      expect(publicCartPricing(catalogue, { ...booking, rateKey: "cost" })).toBeNull();
    });

    it("is null when there is no rate key", () => {
      expect(publicCartPricing(catalogue, { ...booking, rateKey: null })).toBeNull();
    });

    it("is null on every form that is not in cart mode", () => {
      expect(publicCartPricing({ ...catalogue, multiple: false }, booking)).toBeNull();
      expect(publicCartPricing({ fields: catalogue.fields }, booking)).toBeNull();
      expect(publicCartPricing(null, booking)).toBeNull();
      expect(publicCartPricing(catalogue, null)).toBeNull();
    });
  });
});

/**
 * GRAFT-31 — only an owner or admin may write forms; a member may read them.
 * The refusal has to come first: before the body is resolved against an
 * entity, before quota is reserved, before anything is written. So the member
 * cases below hand the service ports that fail the test if touched at all.
 */
describe("form write roles (GRAFT-31)", () => {
  const withRoles = (roles: Ctx["roles"]): Ctx =>
    createContext({
      requestId: "req-roles",
      tenantId: TENANT,
      userId: USER,
      roles,
      tier: "free",
    });
  const member = withRoles(["member"]);
  const admin = withRoles(["admin"]);

  const untouchable = () =>
    vi.fn(async () => {
      throw new Error("a refused member call must not reach this port");
    });

  /** Every FormDeps port wired to fail loudly, plus the spies to prove it. */
  function forbiddenFormDeps() {
    const repoFns = {
      find: untouchable(),
      findOne: untouchable(),
      findById: untouchable(),
      insertOne: untouchable(),
      updateOne: untouchable(),
      softDelete: untouchable(),
      listPage: untouchable(),
      count: untouchable(),
    };
    const repo = {
      collectionName: "forms",
      collection: vi.fn(),
      ...repoFns,
    } as unknown as Repository<FormDoc>;
    const getEntity = untouchable();
    const consumeQuota = untouchable();
    const findTenantById = untouchable();
    const accounts = { findTenantById } as unknown as AccountStore;
    const spies = [...Object.values(repoFns), getEntity, consumeQuota, findTenantById];
    return {
      deps: { repo, getEntity, consumeQuota, accounts } as unknown as Partial<
        Parameters<typeof createForm>[2]
      >,
      spies,
    };
  }

  function forbiddenMediaDeps() {
    const formsFns = {
      find: untouchable(),
      findOne: untouchable(),
      findById: untouchable(),
      insertOne: untouchable(),
      updateOne: untouchable(),
      softDelete: untouchable(),
      listPage: untouchable(),
      count: untouchable(),
    };
    const ports = {
      requestUpload: untouchable(),
      confirmUpload: untouchable(),
      deleteMedia: untouchable(),
      getMedia: untouchable(),
      listMediaFor: untouchable(),
    };
    const deps = {
      forms: { collectionName: "forms", collection: vi.fn(), ...formsFns },
      ...ports,
    } as unknown as Partial<FormMediaDeps>;
    return { deps, spies: [...Object.values(formsFns), ...Object.values(ports)] };
  }

  const FORM = "000000000000000000000031";
  const MEDIA = "000000000000000000000041";

  const expectForbidden = async (call: Promise<unknown>) => {
    const error = await call.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: "FORBIDDEN",
      message: "Only an owner or admin can change forms",
    });
  };

  describe("assertCanWriteForms (AC6)", () => {
    it("lets an owner through", () => {
      expect(() => assertCanWriteForms(ctx)).not.toThrow();
    });

    it("lets an admin through", () => {
      expect(() => assertCanWriteForms(admin)).not.toThrow();
    });

    it("lets someone holding member and admin through", () => {
      expect(() => assertCanWriteForms(withRoles(["member", "admin"]))).not.toThrow();
    });

    it("refuses a member with FORBIDDEN", () => {
      expect(() => assertCanWriteForms(member)).toThrow(AppError);
      expect(() => assertCanWriteForms(member)).toThrow(
        "Only an owner or admin can change forms",
      );
    });
  });

  describe("a member is refused before anything is read, reserved or written (AC1, AC4)", () => {
    const body = {
      entityId: ENTITY_ID,
      name: "Member's form",
      slug: "members-form",
      visibility: "internal",
      fields: [{ key: "name" }],
    };

    const formCalls: [
      string,
      (deps: ReturnType<typeof forbiddenFormDeps>["deps"]) => Promise<unknown>,
    ][] = [
      ["createForm", (deps) => createForm(member, body, deps)],
      ["updateForm", (deps) => updateForm(member, FORM, { name: "Renamed" }, deps)],
      ["deleteForm", (deps) => deleteForm(member, FORM, deps)],
      ["publishForm", (deps) => publishForm(member, FORM, deps)],
      ["unpublishForm", (deps) => unpublishForm(member, FORM, deps)],
    ];

    it.each(formCalls)("%s", async (_name, call) => {
      const { deps, spies } = forbiddenFormDeps();
      await expectForbidden(call(deps));
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    });

    const mediaCalls: [string, (deps: Partial<FormMediaDeps>) => Promise<unknown>][] = [
      [
        "requestFormImageUpload (POST /media)",
        (deps) =>
          requestFormImageUpload(
            member,
            FORM,
            { contentType: "image/png", sizeBytes: 1024 } as never,
            deps,
          ),
      ],
      [
        "attachFormImage (POST /media/:mediaId)",
        (deps) => attachFormImage(member, FORM, MEDIA, "A photo", deps),
      ],
      [
        "removeFormImage (DELETE /media/:mediaId)",
        (deps) => removeFormImage(member, FORM, MEDIA, deps),
      ],
      [
        "updateFormCarousel (PUT /carousel)",
        (deps) => updateFormCarousel(member, FORM, { images: [] }, deps),
      ],
    ];

    it.each(mediaCalls)("%s", async (_name, call) => {
      const { deps, spies } = forbiddenMediaDeps();
      await expectForbidden(call(deps));
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    });

    it("a refused create of an internal form reserves no internal_forms quota (AC4)", async () => {
      const consumeQuota = vi.fn(async (_c: Ctx, meter: Meter) => allowedQuota(meter));
      const { repo, docs } = fakeRepo();
      await expectForbidden(
        createForm(member, body, { repo, getEntity: async () => entity(), consumeQuota }),
      );
      expect(consumeQuota).not.toHaveBeenCalled();
      expect(docs.size).toBe(0);
    });

    it("a refused publish reserves no active_forms quota and leaves the form unpublished (AC4)", async () => {
      const doc = seedDoc();
      const { repo, docs } = fakeRepo([doc]);
      const consumeQuota = vi.fn(async (_c: Ctx, meter: Meter) => allowedQuota(meter));
      await expectForbidden(
        publishForm(member, doc._id.toHexString(), {
          repo,
          accounts: fakeAccounts(TENANT_RECORD),
          consumeQuota,
        }),
      );
      expect(consumeQuota).not.toHaveBeenCalled();
      expect(docs.get(doc._id.toHexString())?.published).toBe(false);
      expect(docs.get(doc._id.toHexString())?.publicSlug).toBeNull();
    });

    it("a refused update leaves the stored form exactly as it was", async () => {
      const doc = seedDoc();
      const { repo, docs } = fakeRepo([doc]);
      await expectForbidden(
        updateForm(member, doc._id.toHexString(), { name: "Renamed" }, { repo }),
      );
      expect(docs.get(doc._id.toHexString())).toEqual(doc);
    });

    it("a refused delete leaves the form live", async () => {
      const doc = seedDoc();
      const { repo, docs } = fakeRepo([doc]);
      await expectForbidden(deleteForm(member, doc._id.toHexString(), { repo }));
      expect(docs.get(doc._id.toHexString())?.deletedAt).toBeNull();
    });
  });

  describe("an admin writes exactly as an owner does (AC2)", () => {
    it("creates an internal form and reserves its quota", async () => {
      const consumeQuota = vi.fn(async (_c: Ctx, meter: Meter) => allowedQuota(meter));
      const { repo } = fakeRepo();
      const form = await createForm(
        admin,
        {
          entityId: ENTITY_ID,
          name: "Admin's form",
          slug: "admins-form",
          visibility: "internal",
          fields: [{ key: "name" }],
        },
        { repo, getEntity: async () => entity(), consumeQuota },
      );
      expect(form.slug).toBe("admins-form");
      expect(consumeQuota).toHaveBeenCalledWith(admin, "internal_forms");
    });

    it("updates, publishes, unpublishes and deletes", async () => {
      const doc = seedDoc();
      const id = doc._id.toHexString();
      const { repo, docs } = fakeRepo([doc]);
      const deps = {
        repo,
        accounts: fakeAccounts(TENANT_RECORD),
        consumeQuota: async (_c: Ctx, meter: Meter) => allowedQuota(meter),
      };
      expect((await updateForm(admin, id, { name: "Renamed" }, deps)).name).toBe("Renamed");
      expect((await publishForm(admin, id, deps)).published).toBe(true);
      expect((await unpublishForm(admin, id, deps)).published).toBe(false);
      await deleteForm(admin, id, deps);
      expect(docs.get(id)?.deletedAt).not.toBeNull();
    });
  });

  describe("a member can still read (AC3)", () => {
    it("lists and gets forms", async () => {
      const doc = seedDoc();
      const { repo } = fakeRepo([doc]);
      const list = await listForms(member, {}, { repo });
      expect(list.items.map((f) => f.id)).toEqual([doc._id.toHexString()]);
      expect((await getForm(member, doc._id.toHexString(), { repo })).id).toBe(
        doc._id.toHexString(),
      );
    });
  });
});
