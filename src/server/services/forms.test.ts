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
  createForm,
  isFormServable,
  meterForVisibility,
  publishForm,
  resolveBooking,
  resolveCatalogue,
  resolveFormFields,
  unpublishForm,
  unpublishFormsForEntity,
  updateForm,
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
      const existing = [...docs.values()].find((d) => d.slug === doc.slug);
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

    async softDelete() {
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

  const input = (over: Record<string, unknown> = {}) => ({
    entityId: "000000000000000000000022",
    fields: ["name"],
    imageField: "photo" as string | null,
    pageSize: 12,
    selectionKey: null as string | null,
    ...over,
  });

  it("stores the resolved config, with the entity id as an ObjectId", () => {
    const config = resolveCatalogue(input(), browse, submit);
    expect(config.entityDefId.toHexString()).toBe("000000000000000000000022");
    expect(config.fields).toEqual(["name"]);
    expect(config.imageField).toBe("photo");
  });

  /** The reason is in the error's field details, not its message — that is
   * what the client renders beside the offending input. */
  const reasonFor = (over: Record<string, unknown>): string => {
    try {
      resolveCatalogue(input(over), browse, submit);
    } catch (error) {
      const details = (error as AppError).details as
        { fields?: Record<string, string> } | undefined;
      return details?.fields?.catalogue ?? "";
    }
    throw new Error("expected resolveCatalogue to throw");
  };

  it("refuses a browse field that is not on the catalogue entity", () => {
    expect(() => resolveCatalogue(input({ fields: ["nope"] }), browse, submit)).toThrow(
      AppError,
    );
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
      resolveCatalogue(input({ selectionKey: "chosen_item" }), browse, submit).selectionKey,
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
    );
    expect(config).toMatchObject({ fields: [], imageField: null, selectionKey: null });
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
