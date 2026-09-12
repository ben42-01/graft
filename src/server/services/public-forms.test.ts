/**
 * Public form submission — unit coverage (GRAFT-09).
 *
 * Everything provable without a real transaction lives here: spam scoring,
 * the honeypot/fill-time rules, field validation against the *form's* schema,
 * and the indistinguishable-404 rule (AC9). The transactional write itself —
 * AC1's atomic triple write, AC2's rollback, AC7's quota hard stop — needs a
 * real MongoDB replica set and is proven in public-forms.integration.test.ts.
 */
import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/http/envelope";
import type { EntityView } from "@/server/services/entities";
import type { FormDoc } from "@/server/services/forms";
import type { Entitlements } from "@/server/services/entitlements";
import { TIER_LIMITS } from "@/server/tiers";
import {
  MIN_FILL_MS,
  isSpamSubmission,
  resolveSelection,
  submitPublicForm,
} from "./public-forms";

const TENANT = new ObjectId("000000000000000000000001");
const ENTITY_ID = new ObjectId("000000000000000000000021");
const FORM_ID = new ObjectId("000000000000000000000031");

const field = (key: string, type: EntityView["fields"][number]["type"] = "text") => ({
  key,
  label: key,
  type,
  required: true,
});

const form = (over: Partial<FormDoc> = {}): FormDoc & { _id: ObjectId } => ({
  _id: FORM_ID,
  tenantId: TENANT,
  entityDefId: ENTITY_ID,
  name: "Contact",
  slug: "contact",
  publicSlug: "acme/contact",
  visibility: "public",
  published: true,
  enabled: true,
  killSwitchAt: null,
  killSwitchBy: null,
  fields: [field("name")],
  showBadge: true,
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

const entity = (): EntityView => ({
  id: ENTITY_ID.toHexString(),
  key: "customers",
  name: "Customers",
  fields: [field("name")],
  schemaVersion: 1,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

const entitlements = (): Entitlements =>
  Object.freeze({
    tenantId: TENANT.toHexString(),
    tier: "free",
    limits: TIER_LIMITS.free,
    features: {} as Entitlements["features"],
    readOnly: [],
    downgradedAt: null,
    billingAnchorDay: 1,
  });

describe("isSpamSubmission", () => {
  const now = 1_000_000;

  it("AC3 — a filled honeypot is spam regardless of timing", () => {
    expect(isSpamSubmission({ hp: "http://spam.example", renderedAt: now - 10_000, now })).toBe(
      true,
    );
  });

  it("an empty honeypot is not itself spam", () => {
    expect(isSpamSubmission({ hp: "", renderedAt: now - 10_000, now })).toBe(false);
  });

  it("AC4 — a submit faster than the minimum fill time is spam", () => {
    expect(isSpamSubmission({ renderedAt: now - (MIN_FILL_MS - 1), now })).toBe(true);
  });

  it("a normally-paced, honeypot-empty submission is not spam", () => {
    expect(isSpamSubmission({ renderedAt: now - (MIN_FILL_MS + 1), now })).toBe(false);
  });
});

describe("submitPublicForm", () => {
  const baseOverrides = () => ({
    findByPublicSlug: vi.fn().mockResolvedValue(form()),
    getEntity: vi.fn().mockResolvedValue(entity()),
    loadEntitlements: vi.fn().mockResolvedValue(entitlements()),
    now: () => new Date("2026-03-01T12:00:00.000Z"),
  });

  const validBody = (extra: Record<string, unknown> = {}) => ({
    data: { name: "Ada Lovelace" },
    _t: new Date("2026-03-01T12:00:00.000Z").getTime() - (MIN_FILL_MS + 1_000),
    ...extra,
  });

  it("AC9 — an unknown slug 404s", async () => {
    const overrides = baseOverrides();
    overrides.findByPublicSlug.mockResolvedValue(null);
    await expect(
      submitPublicForm("req-1", ["acme", "contact"], validBody(), overrides),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("AC9 — an unpublished form 404s the same way", async () => {
    const overrides = baseOverrides();
    overrides.findByPublicSlug.mockResolvedValue(form({ published: false }));
    await expect(
      submitPublicForm("req-1", ["acme", "contact"], validBody(), overrides),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("AC9 — a killed (enabled: false) form 404s the same way, even though published", async () => {
    const overrides = baseOverrides();
    overrides.findByPublicSlug.mockResolvedValue(form({ enabled: false }));
    await expect(
      submitPublicForm("req-1", ["acme", "contact"], validBody(), overrides),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("AC9 — a malformed publicSlug (wrong segment count) 404s rather than 400ing", async () => {
    const overrides = baseOverrides();
    await expect(
      submitPublicForm("req-1", ["acme"], validBody(), overrides),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(overrides.findByPublicSlug).not.toHaveBeenCalled();
  });

  it("AC6 — an unknown field is rejected, not silently dropped", async () => {
    const overrides = baseOverrides();
    await expect(
      submitPublicForm(
        "req-1",
        ["acme", "contact"],
        validBody({ data: { name: "Ada", extra: "nope" } }),
        overrides,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("AC6 — a missing required field is rejected", async () => {
    const overrides = baseOverrides();
    await expect(
      submitPublicForm("req-1", ["acme", "contact"], validBody({ data: {} }), overrides),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("AC3, AC5 — a honeypot hit returns a submissionId without ever loading the entity or entitlements", async () => {
    const overrides = baseOverrides();
    const result = await submitPublicForm(
      "req-1",
      ["acme", "contact"],
      validBody({ _hp: "filled" }),
      overrides,
    );
    expect(result.submissionId).toMatch(/^[0-9a-f]{24}$/);
    expect(overrides.getEntity).not.toHaveBeenCalled();
    expect(overrides.loadEntitlements).not.toHaveBeenCalled();
  });

  it("AC4, AC5 — a too-fast submit is treated identically, no entity or entitlements load", async () => {
    const overrides = baseOverrides();
    const result = await submitPublicForm(
      "req-1",
      ["acme", "contact"],
      validBody({ _t: new Date("2026-03-01T12:00:00.000Z").getTime() }),
      overrides,
    );
    expect(result.submissionId).toMatch(/^[0-9a-f]{24}$/);
    expect(overrides.getEntity).not.toHaveBeenCalled();
  });

  it("AC10 — a deleted entity behind a still-servable form 404s rather than 500ing", async () => {
    const overrides = baseOverrides();
    overrides.getEntity.mockRejectedValue(new AppError("NOT_FOUND", "Entity not found"));
    await expect(
      submitPublicForm("req-1", ["acme", "contact"], validBody(), overrides),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("an unrelated getEntity failure propagates unchanged, not remapped to a 404", async () => {
    const overrides = baseOverrides();
    overrides.getEntity.mockRejectedValue(new AppError("INTERNAL", "boom"));
    await expect(
      submitPublicForm("req-1", ["acme", "contact"], validBody(), overrides),
    ).rejects.toMatchObject({ code: "INTERNAL" });
  });
});

/**
 * Catalogue selection. The rule these pin is that the selection is the
 * server's field, never the visitor's: whatever `data` says about the
 * selection key is discarded, and `_selection` is only honoured after the
 * record it names has been proved to be in this form's own catalogue.
 *
 * That matters because the selection is what an order gets raised against
 * downstream — if a customer could forge it, they could order one thing and
 * be billed for another.
 *
 * Tested through `resolveSelection` rather than `submitPublicForm`, following
 * this module's own split: everything decided before the transaction is a
 * function a unit test can call, and the transactional write is proven
 * against a real replica set in public-forms.integration.test.ts.
 */
describe("resolveSelection", () => {
  const CATALOGUE_ENTITY = new ObjectId("000000000000000000000022");
  const ITEM_ID = "000000000000000000000051";

  const catalogueForm = () =>
    form({
      fields: [field("name"), { ...field("chosen_item"), required: false }],
      catalogue: {
        entityDefId: CATALOGUE_ENTITY,
        fields: ["name"],
        imageField: null,
        pageSize: 12,
        selectionKey: "chosen_item",
      },
    });

  const found = vi.fn(async () => true);
  const missing = vi.fn(async () => false);

  it("refuses a selection that is not in this form's catalogue", async () => {
    await expect(
      resolveSelection(catalogueForm(), { name: "Ada" }, ITEM_ID, missing),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("checks the selection against the catalogue entity, not the form's own", async () => {
    const lookup = vi.fn(async () => true);
    await resolveSelection(catalogueForm(), { name: "Ada" }, ITEM_ID, lookup);
    expect(lookup).toHaveBeenCalledWith(TENANT, CATALOGUE_ENTITY, ITEM_ID);
  });

  it("overwrites a selection key the visitor tried to set themselves", async () => {
    const result = await resolveSelection(
      catalogueForm(),
      { name: "Ada", chosen_item: "forged-value" },
      ITEM_ID,
      found,
    );
    expect(result.data.chosen_item).toBe(ITEM_ID);
    expect(result.selectedRecordId?.toHexString()).toBe(ITEM_ID);
  });

  it("drops a forged selection key outright when no selection was made", async () => {
    const lookup = vi.fn(async () => true);
    const result = await resolveSelection(
      catalogueForm(),
      { name: "Ada", chosen_item: "forged-value" },
      undefined,
      lookup,
    );
    expect(result.data.chosen_item).toBeUndefined();
    expect(result.selectedRecordId).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("leaves an ordinary form's data untouched and its selection null", async () => {
    const lookup = vi.fn(async () => true);
    const result = await resolveSelection(form(), { name: "Ada" }, ITEM_ID, lookup);
    expect(result.data).toEqual({ name: "Ada" });
    expect(result.selectedRecordId).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("ignores a selection on a catalogue that has no selection key", async () => {
    const noKey = form({
      catalogue: {
        entityDefId: CATALOGUE_ENTITY,
        fields: ["name"],
        imageField: null,
        pageSize: 12,
        selectionKey: null,
      },
    });
    const result = await resolveSelection(noKey, { name: "Ada" }, ITEM_ID, found);
    expect(result.selectedRecordId).toBeNull();
  });
});
