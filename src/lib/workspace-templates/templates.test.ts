/**
 * Every shipped workspace template, under every combination of answers an
 * owner can give, must resolve to inputs the real APIs accept — checked with
 * the server's own schemas and resolvers, not a copy of their rules. A
 * template that 400s halfway through "Set up my business" is worse than no
 * template, and it would leave half a workspace behind.
 */
import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import {
  compileEntitySchema,
  createEntitySchema,
  fieldDefSchema,
} from "@/server/services/entities";
import {
  createFormSchema,
  formSlugSchema,
  resolveBooking,
  resolveCatalogue,
  resolveContent,
  resolveFormFields,
} from "@/server/services/forms";
import { createPoolSchema } from "@/server/services/inventory";
import { TIER_LIMITS } from "@/server/tiers";
import {
  findWorkspaceTemplate,
  moduleCosts,
  requirementsOf,
  resolveTemplate,
  TemplateAnswerError,
  WORKSPACE_TEMPLATES,
  type TemplateAnswersInput,
  type WorkspacePlan,
  type WorkspaceTemplate,
} from "./index";

const PAYMENT_LINK = "https://buy.stripe.com/test_abc123";
const TERMS_URL = "https://example.com/terms";

/** Every toggle value × every module subset — the whole answer space. */
function answerCombinations(template: WorkspaceTemplate): TemplateAnswersInput[] {
  let toggleSets: Record<string, boolean | string>[] = [{}];
  for (const toggle of template.toggles) {
    const values =
      toggle.kind === "boolean" ? [true, false] : toggle.options.map((option) => option.value);
    toggleSets = toggleSets.flatMap((set) =>
      values.map((value) => ({ ...set, [toggle.id]: value })),
    );
  }
  const moduleIds = template.modules.map((module) => module.id);
  const moduleSets = Array.from({ length: 2 ** moduleIds.length }, (_, mask) =>
    moduleIds.filter((_, index) => mask & (1 << index)),
  );
  const profiles: TemplateAnswersInput[] = [
    { sampleData: false, publish: false },
    {
      sampleData: true,
      publish: true,
      depositPercent: 25,
      paymentLink: PAYMENT_LINK,
      paymentRequired: true,
      termsUrl: TERMS_URL,
    },
  ];
  return toggleSets.flatMap((toggles) =>
    moduleSets.flatMap((modules) =>
      profiles.map((profile) => ({ ...profile, toggles, modules })),
    ),
  );
}

const fakeId = () => new ObjectId().toHexString();

/** Walks a plan through the same checks `createEntity` / `createForm` / `createPool` run. */
function assertPlanIsAccepted(plan: WorkspacePlan, label: string) {
  const ids = new Map(plan.entities.map((entity) => [entity.ref, fakeId()]));
  const fieldsByRef = new Map(
    plan.entities.map((entity) => [
      entity.ref,
      entity.fields.map((field) => fieldDefSchema.parse(field)),
    ]),
  );

  const keys = plan.entities.map((entity) => entity.key);
  expect(new Set(keys).size, `${label}: duplicate entity keys`).toBe(keys.length);
  const slugs = plan.forms.map((form) => form.slug);
  expect(new Set(slugs).size, `${label}: duplicate form slugs`).toBe(slugs.length);

  for (const entity of plan.entities) {
    const parsed = createEntitySchema.safeParse(entity);
    expect(
      parsed.success,
      `${label}: entity ${entity.ref} ${JSON.stringify(parsed.error?.issues)}`,
    ).toBe(true);
    const fieldKeys = entity.fields.map((field) => field.key);
    expect(new Set(fieldKeys).size, `${label}: ${entity.ref} has duplicate fields`).toBe(
      fieldKeys.length,
    );
  }

  for (const record of plan.records) {
    const schema = compileEntitySchema(fieldsByRef.get(record.entityRef)!);
    const parsed = schema.safeParse(record.data);
    expect(
      parsed.success,
      `${label}: sample ${record.ref} ${JSON.stringify(parsed.error?.issues)}`,
    ).toBe(true);
    if (record.pool) {
      const pool = createPoolSchema.safeParse({
        entityId: ids.get(record.entityRef),
        recordId: fakeId(),
        ...record.pool,
      });
      expect(pool.success, `${label}: pool for ${record.ref}`).toBe(true);
    }
  }

  for (const form of plan.forms) {
    const at = `${label}: form ${form.ref}`;
    expect(formSlugSchema.safeParse(form.slug).success, `${at} slug "${form.slug}"`).toBe(true);
    const entityId = ids.get(form.entityRef)!;
    const input = {
      entityId,
      name: form.name,
      slug: form.slug,
      visibility: form.visibility,
      fields: form.fields.map((key) => ({ key })),
      catalogue: form.catalogue
        ? { ...form.catalogue, entityId: ids.get(form.catalogue.entityRef) }
        : null,
      booking: form.booking,
      payment: form.payment,
      content: form.content,
    };
    const parsed = createFormSchema.safeParse(input);
    expect(parsed.success, `${at} ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    if (!parsed.success) continue;

    const entityFields = fieldsByRef.get(form.entityRef)!;
    const fields = resolveFormFields(parsed.data.fields, entityFields);
    const catalogueFields = form.catalogue ? fieldsByRef.get(form.catalogue.entityRef)! : [];
    const catalogue = parsed.data.catalogue
      ? resolveCatalogue(parsed.data.catalogue, catalogueFields, entityFields, entityId)
      : null;
    if (parsed.data.booking) {
      resolveBooking(parsed.data.booking, fields, catalogue, catalogueFields);
    }
    resolveContent(parsed.data.content ?? [], fields);

    if (form.catalogue) {
      // Submissions are validated against the form's field list, and the
      // selection is written under this key before that check — so it must
      // be on the form, and must not be something a visitor has to fill.
      const selection = fields.find((field) => field.key === form.catalogue!.selectionKey);
      expect(selection, `${at}: selection field not on the form`).toBeDefined();
      expect(selection!.required, `${at}: selection field is required`).toBe(false);
    }
    if (form.booking) {
      const byKey = new Map(fields.map((field) => [field.key, field]));
      expect(byKey.get(form.booking.startKey)?.required, `${at}: optional start`).toBe(true);
      if (form.booking.endKey) {
        expect(byKey.get(form.booking.endKey)?.required, `${at}: optional end`).toBe(true);
      }
      expect(form.booking.rateKey, `${at}: booking has no rate field`).not.toBeNull();
      expect(form.booking.labelKey, `${at}: booking has no label field`).not.toBeNull();
    }
  }
}

function allText(plan: WorkspacePlan): string[] {
  return [
    ...plan.entities.flatMap((entity) => [
      entity.name,
      ...entity.fields.map((field) => field.label),
    ]),
    ...plan.records.flatMap((record) =>
      Object.values(record.data).filter((value): value is string => typeof value === "string"),
    ),
    ...plan.forms.flatMap((form) => [
      form.name,
      ...form.content.flatMap((block) =>
        block.kind === "notice" ? [block.title, block.body] : [block.label],
      ),
    ]),
  ];
}

describe("WORKSPACE_TEMPLATES", () => {
  it("ships the ten business templates", () => {
    expect(WORKSPACE_TEMPLATES).toHaveLength(10);
    const ids = WORKSPACE_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe.each(WORKSPACE_TEMPLATES.map((template) => [template.id, template] as const))(
    "%s",
    (_id, template) => {
      it("references only its own entities, toggles and modules", () => {
        const refs = new Set(template.entities.map((entity) => entity.ref));
        const toggles = new Set(template.toggles.map((toggle) => toggle.id));
        const modules = new Set(template.modules.map((module) => module.id));
        const nouns = new Set(template.nouns.map((noun) => noun.id));
        for (const entity of template.entities) {
          if (entity.module) expect(modules).toContain(entity.module);
          if (entity.noun) expect(nouns).toContain(entity.noun);
        }
        for (const set of template.samples) expect(refs).toContain(set.entityRef);
        for (const form of template.forms) {
          expect(refs).toContain(form.entityRef);
          if (form.catalogue) expect(refs).toContain(form.catalogue.entityRef);
          if (form.module) expect(modules).toContain(form.module);
        }
        const conditions = JSON.stringify(template).matchAll(/"toggle":"([a-z0-9_]+)"/g);
        for (const [, id] of conditions) expect(toggles).toContain(id);
      });

      it("is accepted by the real APIs under every combination of answers", () => {
        for (const answers of answerCombinations(template)) {
          const plan = resolveTemplate(template, answers);
          assertPlanIsAccepted(
            plan,
            `${template.id} ${JSON.stringify(answers.toggles)} ${answers.modules}`,
          );
        }
      });

      it("leaves no unfilled {placeholder} anywhere", () => {
        for (const answers of answerCombinations(template)) {
          for (const text of allText(resolveTemplate(template, answers))) {
            expect(text).not.toMatch(/\{[A-Za-z_.]+\}/);
          }
        }
      });

      it("makes sample resources bookable whenever a booking form is created", () => {
        for (const answers of answerCombinations(template).filter((a) => a.sampleData)) {
          const plan = resolveTemplate(template, answers);
          for (const form of plan.forms.filter((candidate) => candidate.booking)) {
            const pooled = plan.records.filter(
              (record) => record.entityRef === form.catalogue!.entityRef && record.pool,
            );
            expect(
              pooled.length,
              `${template.id}: ${form.ref} has nothing to book`,
            ).toBeGreaterThan(0);
          }
        }
      });

      it("fits its core in a fresh Free workspace, with room for a module", () => {
        const free = TIER_LIMITS.free;
        const core = requirementsOf(resolveTemplate(template, { publish: true }));
        expect(core.entities).toBeLessThanOrEqual((free.entities ?? Infinity) - 1);
        expect(core.active_forms).toBeLessThanOrEqual(1);
        expect(core.internal_forms).toBeLessThanOrEqual(free.internalForms ?? Infinity);
        expect(core.records).toBeLessThanOrEqual(free.records ?? Infinity);
      });

      it("prices each module as what it adds, never a negative", () => {
        for (const cost of Object.values(moduleCosts(template))) {
          expect(cost.entities).toBeGreaterThanOrEqual(1);
          for (const value of Object.values(cost)) expect(value).toBeGreaterThanOrEqual(0);
        }
      });
    },
  );
});

describe("resolveTemplate", () => {
  const hotel = findWorkspaceTemplate("hotel")!;

  it("applies the template as designed when given no answers", () => {
    const plan = resolveTemplate(hotel);
    expect(plan.entities.map((entity) => entity.key)).toEqual(["rooms", "reservations"]);
    expect(plan.records).toHaveLength(3);
    expect(plan.records.every((record) => record.pool?.strategy === "individual_asset")).toBe(
      true,
    );
    const form = plan.forms[0]!;
    expect(form).toMatchObject({ slug: "book-a-room", publish: true, payment: null });
    expect(form.booking).toMatchObject({
      rateBasis: "daily",
      endKey: "check_out",
      depositPercent: null,
    });
  });

  it("renames the resource everywhere it is named", () => {
    const plan = resolveTemplate(hotel, {
      nouns: { room: { singular: "Cabin", plural: "Cabins" } },
    });
    expect(plan.entities[0]).toMatchObject({ key: "cabins", name: "Cabins" });
    expect(plan.forms[0]).toMatchObject({ name: "Book a cabin", slug: "book-a-cabin" });
    expect(plan.records[0]!.data.name).toBe("Cabin 101");
    expect(plan.entities[1]!.fields.find((field) => field.key === "selected_item")!.label).toBe(
      "Cabin",
    );
  });

  it("keeps an acronym's capitals mid-sentence", () => {
    const plan = resolveTemplate(hotel, {
      nouns: { room: { singular: "VIP suite", plural: "VIP suites" } },
    });
    expect(plan.forms[0]!.name).toBe("Book a VIP suite");
  });

  it("switches to pooled room types with a quantity field", () => {
    const plan = resolveTemplate(hotel, { toggles: { unit_mode: "types" } });
    expect(plan.records.map((record) => record.pool)).toEqual([
      { strategy: "pooled_quantity", totalQuantity: 6 },
      { strategy: "pooled_quantity", totalQuantity: 4 },
      { strategy: "pooled_quantity", totalQuantity: 2 },
    ]);
    expect(plan.forms[0]!.booking!.quantityKey).toBe("rooms_needed");
  });

  it("turns an enquiry-only template into a form with no booking and no pools", () => {
    const plan = resolveTemplate(hotel, { toggles: { bookable: false } });
    expect(plan.forms[0]!.booking).toBeNull();
    expect(plan.forms[0]!.catalogue).not.toBeNull();
    expect(plan.records.every((record) => record.pool === null)).toBe(true);
  });

  it("drops an unticked optional field from the entity, the form and the catalogue", () => {
    const plan = resolveTemplate(hotel, {
      omitFields: ["rooms.description", "reservations.phone"],
    });
    expect(plan.entities[0]!.fields.map((field) => field.key)).not.toContain("description");
    expect(plan.forms[0]!.catalogue!.fields).not.toContain("description");
    expect(plan.forms[0]!.fields).not.toContain("phone");
    expect(plan.records[0]!.data).not.toHaveProperty("description");
  });

  it("attaches deposit, payment link and terms where the template asks for them", () => {
    const plan = resolveTemplate(hotel, {
      depositPercent: 30,
      paymentLink: PAYMENT_LINK,
      termsUrl: TERMS_URL,
    });
    const form = plan.forms[0]!;
    expect(form.booking!.depositPercent).toBe(30);
    expect(form.payment).toEqual({
      mode: "link",
      link: { url: PAYMENT_LINK },
      required: false,
    });
    expect(form.content.map((block) => block.id)).toEqual(["n1", "policy", "terms"]);
    expect(form.content.at(-1)).toMatchObject({
      kind: "link",
      label: "the house rules",
      requireAgreement: true,
    });
  });

  it("adds a module's entities and forms only when chosen", () => {
    expect(resolveTemplate(hotel).entities).toHaveLength(2);
    const plan = resolveTemplate(hotel, { modules: ["housekeeping"] });
    expect(plan.entities.map((entity) => entity.key)).toContain("housekeeping_tasks");
    expect(plan.forms.map((form) => form.ref)).toContain("housekeeping_log");
    expect(moduleCosts(hotel).housekeeping).toEqual({
      entities: 1,
      records: 0,
      internal_forms: 1,
      active_forms: 0,
    });
  });

  it("takes a duration and a rate basis from choice toggles", () => {
    const pro = findWorkspaceTemplate("professional_services")!;
    const plan = resolveTemplate(pro, {
      toggles: { session_length: "min_120", rate_basis: "hourly" },
    });
    expect(plan.forms[0]!.booking).toMatchObject({ durationMinutes: 120, rateBasis: "hourly" });
  });

  it.each([
    [{ paymentLink: "https://evil.example/pay" }, "paymentLink"],
    [{ termsUrl: "javascript:alert(1)" }, "termsUrl"],
    [{ toggles: { nope: true } }, "toggles"],
    [{ toggles: { bookable: "yes" } }, "toggles"],
    [{ toggles: { unit_mode: "castles" } }, "toggles"],
    [{ modules: ["spa"] }, "modules"],
    [{ nouns: { guest: { singular: "a", plural: "b" } } }, "nouns"],
    [{ omitFields: ["rooms.nightly_rate"] }, "omitFields"],
    [{ omitFields: ["rooms.nope"] }, "omitFields"],
    [{ depositPercent: 150 }, "depositPercent"],
  ] as const)("refuses %j, reporting %s", (answers, field) => {
    expect(() => resolveTemplate(hotel, answers as TemplateAnswersInput)).toThrow(
      TemplateAnswerError,
    );
    try {
      resolveTemplate(hotel, answers as TemplateAnswersInput);
    } catch (error) {
      expect((error as TemplateAnswerError).field).toBe(field);
    }
  });
});
