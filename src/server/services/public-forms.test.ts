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
  MAX_CART_LINES,
  MAX_CART_SUMMARY_LENGTH,
  MIN_FILL_MS,
  assertChoiceShape,
  isSpamSubmission,
  resolveCart,
  submitFormSchema,
  resolveAgreements,
  resolvePaymentHandoff,
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

/**
 * GRAFT-24 — the payment handoff (AC4–AC8). Pure by design: the reference the
 * URL carries is decided from the order the bridge raised (or, failing that,
 * the submission), and everything about *building* the URL is provable
 * without a transaction.
 */
describe("resolvePaymentHandoff", () => {
  const ORDER_ID = "0000000000000000000000a1";
  const SUBMISSION_ID = "0000000000000000000000b2";

  const payment = (
    over: Partial<Extract<NonNullable<FormDoc["payment"]>, { mode: "link" }>> = {},
  ) => ({
    mode: "link" as const,
    link: { url: "https://buy.stripe.com/abc" },
    required: true,
    ...over,
  });

  it("AC5 — a form with no payment config hands off nothing", () => {
    expect(resolvePaymentHandoff(null, SUBMISSION_ID)).toBeNull();
    expect(resolvePaymentHandoff(undefined, SUBMISSION_ID)).toBeNull();
  });

  it("AC4, AC6 — the order id is the reference when there is an order", () => {
    const handoff = resolvePaymentHandoff(payment(), ORDER_ID);
    expect(handoff).not.toBeNull();
    const url = new URL(handoff!.url);
    expect(url.origin).toBe("https://buy.stripe.com");
    expect(url.searchParams.get("client_reference_id")).toBe(ORDER_ID);
    expect(handoff!.required).toBe(true);
  });

  it("AC7 — the reference is never empty", () => {
    const handoff = resolvePaymentHandoff(payment(), SUBMISSION_ID);
    expect(new URL(handoff!.url).searchParams.get("client_reference_id")).toBe(SUBMISSION_ID);
  });

  it("AC8 — the tenant's own query string survives", () => {
    const handoff = resolvePaymentHandoff(
      payment({ link: { url: "https://buy.stripe.com/abc?prefilled_email=x" } }),
      ORDER_ID,
    );
    const url = new URL(handoff!.url);
    expect(url.searchParams.get("prefilled_email")).toBe("x");
    expect(url.searchParams.get("client_reference_id")).toBe(ORDER_ID);
  });

  it("AC8 — a client_reference_id the tenant pasted is overwritten, not duplicated", () => {
    const handoff = resolvePaymentHandoff(
      payment({ link: { url: "https://buy.stripe.com/abc?client_reference_id=theirs" } }),
      ORDER_ID,
    );
    const url = new URL(handoff!.url);
    expect(url.searchParams.getAll("client_reference_id")).toEqual([ORDER_ID]);
  });

  it("AC9 — `required: false` is carried through as an offer, not a redirect", () => {
    expect(resolvePaymentHandoff(payment({ required: false }), ORDER_ID)!.required).toBe(false);
  });

  /**
   * Fail closed (Constraints): the stored value is re-validated on the way
   * out, so a document written before this shipped — or by any path that
   * bypassed the schema — cannot turn the public form into an open redirect.
   */
  it("omits a stored URL that no longer validates rather than returning it", () => {
    expect(
      resolvePaymentHandoff(
        { mode: "link", link: { url: "https://evil.test/x" }, required: true },
        ORDER_ID,
      ),
    ).toBeNull();
  });
});

describe("submitPublicForm — the payment block on the response (GRAFT-24)", () => {
  const overrides = () => ({
    findByPublicSlug: vi.fn().mockResolvedValue(
      form({
        payment: { mode: "link", link: { url: "https://buy.stripe.com/abc" }, required: true },
      }),
    ),
    getEntity: vi.fn().mockResolvedValue(entity()),
    loadEntitlements: vi.fn().mockResolvedValue(entitlements()),
    now: () => new Date("2026-03-01T12:00:00.000Z"),
  });

  const body = (extra: Record<string, unknown> = {}) => ({
    data: { name: "Ada Lovelace" },
    _t: new Date("2026-03-01T12:00:00.000Z").getTime() - (MIN_FILL_MS + 1_000),
    ...extra,
  });

  /**
   * The spam path is the one response shape provable without a replica set,
   * and it has to carry the payment block for the same reason it carries a
   * submissionId: a bot must not be able to tell acceptance from rejection.
   */
  it("AC4, AC7 — a payment-enabled form answers with a payment URL keyed by the submission", async () => {
    const result = await submitPublicForm(
      "req-1",
      ["acme", "contact"],
      body({ _hp: "filled" }),
      overrides(),
    );
    expect(result.payment).toBeDefined();
    expect(new URL(result.payment!.url).searchParams.get("client_reference_id")).toBe(
      result.submissionId,
    );
  });

  it("a checkout form's spam response opens no Stripe session and carries no payment key", async () => {
    const checkout = { ...overrides(), createCheckout: vi.fn() };
    checkout.findByPublicSlug.mockResolvedValue(
      form({ payment: { mode: "checkout", required: true } }),
    );
    const result = await submitPublicForm(
      "req-1",
      ["acme", "contact"],
      body({ _hp: "filled" }),
      checkout,
    );
    expect("payment" in result).toBe(false);
    expect(checkout.createCheckout).not.toHaveBeenCalled();
  });

  it("a manual form answers with its instructions and no payment block, spam or not", async () => {
    const manual = { ...overrides(), createCheckout: vi.fn() };
    manual.findByPublicSlug.mockResolvedValue(
      form({ payment: { mode: "manual", instructions: "We'll email bank details." } }),
    );
    const result = await submitPublicForm(
      "req-1",
      ["acme", "contact"],
      body({ _hp: "filled" }),
      manual,
    );
    expect("payment" in result).toBe(false);
    expect(result.paymentInstructions).toBe("We'll email bank details.");
    expect(manual.createCheckout).not.toHaveBeenCalled();
  });

  it("a manual form with no instructions carries no instructions key", async () => {
    const manual = overrides();
    manual.findByPublicSlug.mockResolvedValue(
      form({ payment: { mode: "manual", instructions: "" } }),
    );
    const result = await submitPublicForm(
      "req-1",
      ["acme", "contact"],
      body({ _hp: "filled" }),
      manual,
    );
    expect("payment" in result).toBe(false);
    expect("paymentInstructions" in result).toBe(false);
  });

  it("AC5 — an ordinary form's response has no payment key at all", async () => {
    const plain = overrides();
    plain.findByPublicSlug.mockResolvedValue(form());
    const result = await submitPublicForm(
      "req-1",
      ["acme", "contact"],
      body({ _hp: "filled" }),
      plain,
    );
    expect("payment" in result).toBe(false);
  });
});

describe("resolveAgreements — links a customer must agree to", () => {
  const NOW = new Date("2026-03-01T12:00:00.000Z");
  const terms = {
    id: "terms",
    kind: "link" as const,
    label: "Terms of hire",
    url: "https://example.com/terms",
    requireAgreement: true,
    after: null,
  };
  const site = {
    id: "site",
    kind: "link" as const,
    label: "Our website",
    url: "https://example.com",
    requireAgreement: false,
    after: null,
  };

  it("records nothing on a form with no required agreement", () => {
    expect(resolveAgreements(undefined, undefined, NOW)).toEqual([]);
    expect(resolveAgreements([site], undefined, NOW)).toEqual([]);
  });

  it("refuses a submission that did not agree, naming the link", () => {
    expect(() => resolveAgreements([terms, site], ["site"], NOW)).toThrow(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        details: {
          source: "body",
          fields: { "_agreed.terms": "Please agree to Terms of hire before sending." },
        },
      }),
    );
  });

  it("snapshots what was agreed to, ignoring ids that name no required link", () => {
    expect(resolveAgreements([terms, site], ["terms", "site", "bogus"], NOW)).toEqual([
      {
        blockId: "terms",
        label: "Terms of hire",
        url: "https://example.com/terms",
        agreedAt: NOW,
      },
    ]);
  });

  it("submitPublicForm refuses a missing agreement before loading the entity", async () => {
    const getEntity = vi.fn().mockResolvedValue(entity());
    await expect(
      submitPublicForm(
        "req-1",
        ["acme", "contact"],
        { data: { name: "Ada" }, _t: NOW.getTime() - (MIN_FILL_MS + 1_000) },
        {
          findByPublicSlug: vi.fn().mockResolvedValue(form({ content: [terms] })),
          getEntity,
          loadEntitlements: vi.fn().mockResolvedValue(entitlements()),
          now: () => NOW,
        },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(getEntity).not.toHaveBeenCalled();
  });
});

/**
 * GRAFT-30.2 — cart submissions. Everything decided before the transaction:
 * the shape of `_cart` (AC2, AC5), which forms take which shape (AC6), and
 * cart resolution against the form's own catalogue (AC4, AC8). The priced
 * order and its all-or-nothing write are booking-bridge.test.ts and
 * booking-bridge.integration.test.ts.
 */
describe("submitFormSchema — _cart", () => {
  const A = "0000000000000000000000a1";
  const B = "0000000000000000000000a2";
  const body = (cart: unknown) => ({ data: {}, _t: 1, _cart: cart });
  const errors = (cart: unknown) => {
    const result = submitFormSchema.safeParse(body(cart));
    return result.success ? null : result.error.issues.map((issue) => issue.path.join("."));
  };

  it("accepts a cart of record ids and quantities", () => {
    expect(
      errors([
        { recordId: A, quantity: 2 },
        { recordId: B, quantity: 1 },
      ]),
    ).toBeNull();
  });

  it.each(["price", "amount", "unitAmountMinor", "amountMinor", "total", "rate"])(
    "AC2 — refuses a line carrying `%s` rather than stripping it",
    (key) => {
      expect(errors([{ recordId: A, quantity: 1, [key]: 1 }])).toEqual(["_cart.0"]);
    },
  );

  it("AC5 — refuses an empty cart", () => {
    expect(errors([])).toEqual(["_cart"]);
  });

  it("AC5 — refuses more than 20 lines", () => {
    const lines = Array.from({ length: MAX_CART_LINES + 1 }, (_, i) => ({
      recordId: i.toString(16).padStart(24, "0"),
      quantity: 1,
    }));
    expect(errors(lines)).toEqual(["_cart"]);
    expect(errors(lines.slice(0, MAX_CART_LINES))).toBeNull();
  });

  it("AC5 — refuses the same record twice, naming the repeat, whatever its case", () => {
    expect(
      errors([
        { recordId: A, quantity: 1 },
        { recordId: B, quantity: 1 },
        { recordId: A.toUpperCase(), quantity: 3 },
      ]),
    ).toEqual(["_cart.2"]);
  });

  it.each([0, -1, 100_001, 1.5])("AC5 — refuses a quantity of %s", (quantity) => {
    expect(errors([{ recordId: A, quantity }])).toEqual(["_cart.0.quantity"]);
  });

  it("AC5 — accepts the quantity bounds themselves", () => {
    expect(errors([{ recordId: A, quantity: 1 }])).toBeNull();
    expect(errors([{ recordId: A, quantity: 100_000 }])).toBeNull();
  });

  it("refuses a record id that is not an object id", () => {
    expect(errors([{ recordId: "not-an-id", quantity: 1 }])).toEqual(["_cart.0.recordId"]);
  });
});

describe("assertChoiceShape", () => {
  const CATALOGUE_ENTITY = new ObjectId("000000000000000000000022");
  const catalogue = (multiple: boolean) => ({
    entityDefId: CATALOGUE_ENTITY,
    fields: ["name"],
    imageField: null,
    pageSize: 12,
    selectionKey: "chosen_item",
    multiple,
  });

  it("AC6 — refuses a cart on a single-selection form", () => {
    expect(() => assertChoiceShape({ catalogue: catalogue(false) }, { _cart: [] })).toThrow(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        details: { source: "body", fields: { _cart: expect.any(String) } },
      }),
    );
  });

  it("AC6 — refuses a cart on a form with no catalogue at all", () => {
    expect(() => assertChoiceShape({ catalogue: null }, { _cart: [] })).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });

  it("AC6 — refuses a single selection on a cart form", () => {
    expect(() =>
      assertChoiceShape({ catalogue: catalogue(true) }, { _selection: "a".repeat(24) }),
    ).toThrow(
      expect.objectContaining({
        details: { source: "body", fields: { _selection: expect.any(String) } },
      }),
    );
  });

  it("lets each form's own shape through, and a form with neither", () => {
    expect(() =>
      assertChoiceShape({ catalogue: catalogue(true) }, { _cart: [] }),
    ).not.toThrow();
    expect(() =>
      assertChoiceShape({ catalogue: catalogue(false) }, { _selection: "a".repeat(24) }),
    ).not.toThrow();
    expect(() => assertChoiceShape({ catalogue: catalogue(true) }, {})).not.toThrow();
  });
});

describe("resolveCart", () => {
  const CATALOGUE_ENTITY = new ObjectId("000000000000000000000022");
  const LOAF = "0000000000000000000000a1";
  const VEG_BOX = "0000000000000000000000a2";

  const cartForm = (over: { max?: number; labelKey?: string | null } = {}) =>
    form({
      fields: [
        field("name"),
        { ...field("chosen_item"), required: false, ...(over.max ? { max: over.max } : {}) },
      ],
      catalogue: {
        entityDefId: CATALOGUE_ENTITY,
        fields: ["name"],
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
        rateBasis: "flat",
        rateKey: "price",
        labelKey: over.labelKey === undefined ? "name" : over.labelKey,
        depositPercent: null,
      },
    });

  const catalogueRows = [
    { id: LOAF, data: { name: "Sourdough loaf", title: "Loaf", price: 5 } },
    { id: VEG_BOX, data: { name: "Veg box", title: "Box", price: 22 } },
  ];
  const lookup = () => vi.fn(async () => catalogueRows);

  const cart = [
    { recordId: LOAF, quantity: 2 },
    { recordId: VEG_BOX, quantity: 1 },
  ];

  it("looks the whole cart up in this form's catalogue entity and tenant, in one read", async () => {
    const find = lookup();
    await resolveCart(cartForm(), { name: "Ada" }, cart, find);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith(TENANT, CATALOGUE_ENTITY, [LOAF, VEG_BOX]);
  });

  it("returns the lines as ids and quantities only — no price travels", async () => {
    const result = await resolveCart(cartForm(), { name: "Ada" }, cart, lookup());
    expect(result.cart).toEqual([
      { recordId: new ObjectId(LOAF), quantity: 2 },
      { recordId: new ObjectId(VEG_BOX), quantity: 1 },
    ]);
  });

  it("AC4 — refuses a line the scoped lookup did not find, naming its index", async () => {
    // Another tenant's record, another entity's record and a deleted record
    // all look the same from here: the scoped read simply does not return it.
    const find = vi.fn(async () => [catalogueRows[0]]);
    await expect(resolveCart(cartForm(), { name: "Ada" }, cart, find)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { source: "body", fields: { "_cart.1": "That item is no longer available" } },
    });
  });

  it("AC8 — writes a readable summary under the selection key, overwriting the visitor's", async () => {
    const result = await resolveCart(
      cartForm(),
      { name: "Ada", chosen_item: "forged-value" },
      cart,
      lookup(),
    );
    expect(result.data).toEqual({
      name: "Ada",
      chosen_item: "2 × Sourdough loaf, 1 × Veg box",
    });
  });

  it("AC8 — names items by the form's configured label field", async () => {
    const result = await resolveCart(
      cartForm({ labelKey: "title" }),
      { name: "Ada" },
      cart,
      lookup(),
    );
    expect(result.data.chosen_item).toBe("2 × Loaf, 1 × Box");
  });

  it("AC8 — clips the summary to the selection field's maximum length", async () => {
    const result = await resolveCart(cartForm({ max: 12 }), { name: "Ada" }, cart, lookup());
    expect(result.data.chosen_item).toBe("2 × Sourdou…");
    expect(String(result.data.chosen_item)).toHaveLength(12);
  });

  it("AC8 — clips to a fixed ceiling when the field sets no maximum", async () => {
    const long = Array.from({ length: 20 }, (_, i) => ({
      id: i.toString(16).padStart(24, "0"),
      data: { name: "An item with a rather long descriptive name" },
    }));
    const result = await resolveCart(
      cartForm(),
      { name: "Ada" },
      long.map((row) => ({ recordId: row.id, quantity: 100_000 })),
      vi.fn(async () => long),
    );
    expect(String(result.data.chosen_item)).toHaveLength(MAX_CART_SUMMARY_LENGTH);
  });

  it("drops a forged selection value and raises no cart when none was sent", async () => {
    const find = lookup();
    const result = await resolveCart(
      cartForm(),
      { name: "Ada", chosen_item: "forged-value" },
      undefined,
      find,
    );
    expect(result).toEqual({ data: { name: "Ada" }, cart: null });
    expect(find).not.toHaveBeenCalled();
  });
});

describe("submitPublicForm — cart shape (GRAFT-30.2)", () => {
  const overrides = (catalogueMultiple: boolean) => ({
    findByPublicSlug: vi.fn().mockResolvedValue(
      form({
        fields: [field("name"), { ...field("chosen_item"), required: false }],
        catalogue: {
          entityDefId: new ObjectId("000000000000000000000022"),
          fields: ["name"],
          imageField: null,
          pageSize: 12,
          selectionKey: "chosen_item",
          multiple: catalogueMultiple,
        },
      }),
    ),
    getEntity: vi.fn().mockResolvedValue(entity()),
    loadEntitlements: vi.fn().mockResolvedValue(entitlements()),
    findCatalogueRecords: vi.fn(async () => []),
    findCatalogueRecord: vi.fn(async () => true),
    now: () => new Date("2026-03-01T12:00:00.000Z"),
  });
  const body = (extra: Record<string, unknown>) => ({
    data: { name: "Ada" },
    _t: new Date("2026-03-01T12:00:00.000Z").getTime() - 5_000,
    ...extra,
  });

  it("AC6 — `_cart` on a single-selection form is a 400 before anything loads", async () => {
    const deps = overrides(false);
    await expect(
      submitPublicForm(
        "req-1",
        ["acme", "contact"],
        body({ _cart: [{ recordId: "0000000000000000000000a1", quantity: 1 }] }),
        deps,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fields: { _cart: expect.any(String) } },
    });
    expect(deps.getEntity).not.toHaveBeenCalled();
    expect(deps.findCatalogueRecords).not.toHaveBeenCalled();
  });

  it("AC6 — `_selection` on a cart form is a 400 before anything loads", async () => {
    const deps = overrides(true);
    await expect(
      submitPublicForm(
        "req-1",
        ["acme", "contact"],
        body({ _selection: "0000000000000000000000a1" }),
        deps,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fields: { _selection: expect.any(String) } },
    });
    expect(deps.findCatalogueRecord).not.toHaveBeenCalled();
    expect(deps.getEntity).not.toHaveBeenCalled();
  });

  it("AC4 — an unknown cart line is a 400 on `_cart.<i>` before anything is written", async () => {
    const deps = overrides(true);
    await expect(
      submitPublicForm(
        "req-1",
        ["acme", "contact"],
        body({ _cart: [{ recordId: "0000000000000000000000a1", quantity: 1 }] }),
        deps,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fields: { "_cart.0": "That item is no longer available" } },
    });
    expect(deps.getEntity).not.toHaveBeenCalled();
  });
});
