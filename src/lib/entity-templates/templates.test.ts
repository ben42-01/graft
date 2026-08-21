/**
 * Every shipped template must be something the API would actually accept —
 * a template that 400s on "Create entity" is worse than no template at all.
 * These checks are the reason the library can be plain JSON: the rules live
 * here rather than in each file.
 */
import { describe, expect, it } from "vitest";
import { createEntitySchema } from "@/server/services/entities";
import { entityTemplateSchema } from "./schema";
import { ENTITY_TEMPLATES, findTemplate, templatesByCategory } from "./index";

describe("ENTITY_TEMPLATES", () => {
  it("ships a usable library, not a token one", () => {
    expect(ENTITY_TEMPLATES.length).toBeGreaterThanOrEqual(15);
  });

  it("has unique ids and unique entity keys", () => {
    const ids = ENTITY_TEMPLATES.map((template) => template.id);
    const keys = ENTITY_TEMPLATES.map((template) => template.entity.key);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(ENTITY_TEMPLATES.map((template) => [template.id, template] as const))(
    "%s is a well-formed template",
    (_id, template) => {
      expect(entityTemplateSchema.safeParse(template)).toMatchObject({ success: true });
    },
  );

  it.each(ENTITY_TEMPLATES.map((template) => [template.id, template] as const))(
    "%s would be accepted by the entities API",
    (_id, template) => {
      // The exact payload `NewEntityDialog` sends when seeded from it.
      const result = createEntitySchema.safeParse({
        key: template.entity.key,
        name: template.entity.name,
        fields: template.entity.fields,
      });
      expect(result.success).toBe(true);
    },
  );

  it.each(ENTITY_TEMPLATES.map((template) => [template.id, template] as const))(
    "%s has unique field keys",
    (_id, template) => {
      const keys = template.entity.fields.map((field) => field.key);
      expect(new Set(keys).size).toBe(keys.length);
    },
  );

  it("starts every template with at least one required field", () => {
    for (const template of ENTITY_TEMPLATES) {
      expect(
        template.entity.fields.some((field) => field.required),
        `${template.id} has no required field`,
      ).toBe(true);
    }
  });
});

describe("templatesByCategory", () => {
  it("groups every template exactly once", () => {
    const grouped = templatesByCategory().flatMap((group) => group.templates);
    expect(grouped).toHaveLength(ENTITY_TEMPLATES.length);
    expect(new Set(grouped.map((t) => t.id)).size).toBe(ENTITY_TEMPLATES.length);
  });
});

describe("findTemplate", () => {
  it("finds by id, and is undefined for an unknown one", () => {
    expect(findTemplate("customers")?.entity.key).toBe("customers");
    expect(findTemplate("nope")).toBeUndefined();
  });
});
