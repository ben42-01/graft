/**
 * The starting field shapes — what the later steps depend on existing, and
 * the rules `fieldDefSchema` would otherwise refuse.
 */
import { describe, expect, it } from "vitest";
import { validateFields, draftFieldsFrom } from "@/lib/entities/draft-fields";
import { SETUP_INTENTS } from "./flow";
import {
  requestEntityName,
  SELECTION_FIELD,
  suggestedRequestFields,
  suggestedResourceFields,
} from "./suggested-fields";

/** Every suggestion has to survive the editor's own validation, since that is
 * the only thing between it and `createEntitySchema`. */
function expectValid(fields: ReturnType<typeof suggestedResourceFields>) {
  expect(validateFields(draftFieldsFrom(fields, false))).toBeNull();
}

describe("suggestedResourceFields", () => {
  it("is valid input to the entity builder for every intent", () => {
    for (const intent of SETUP_INTENTS) expectValid(suggestedResourceFields(intent));
  });

  it("never suggests a required picture — one can only be added after the record exists", () => {
    for (const intent of SETUP_INTENTS) {
      const image = suggestedResourceFields(intent).find((field) => field.type === "image");
      expect(image?.required ?? false).toBe(false);
    }
  });

  it("gives a bookable thing a number field to price it from", () => {
    const price = suggestedResourceFields("bookings").find((field) => field.type === "number");
    expect(price).toBeDefined();
    // The form step maps this field to the rate; it is not found by its key.
    expect(price?.note).toMatch(/form step/i);
  });

  it("keeps a plain list plain — no photo, no price", () => {
    const types = suggestedResourceFields("list").map((field) => field.type);
    expect(types).not.toContain("image");
    expect(types).not.toContain("number");
  });

  it("always starts with one required field, so a record means something", () => {
    for (const intent of SETUP_INTENTS) {
      expect(suggestedResourceFields(intent)[0].required).toBe(true);
    }
  });
});

describe("suggestedRequestFields", () => {
  it("is valid input to the entity builder for every intent", () => {
    for (const intent of SETUP_INTENTS) expectValid(suggestedRequestFields(intent));
  });

  it("carries the contact details, because this record is the customer", () => {
    const keys = suggestedRequestFields("enquiries").map((field) => field.key);
    expect(keys).toContain("name");
    expect(keys).toContain("email");
  });

  it("gives a booking request the date field availability is checked against", () => {
    const dates = suggestedRequestFields("bookings").filter((field) => field.type === "date");
    expect(dates.length).toBeGreaterThanOrEqual(1);
    expect(dates[0].required).toBe(true);
  });

  it("includes somewhere for the chosen item to land, on every intent that has a form", () => {
    for (const intent of ["enquiries", "bookings"] as const) {
      expect(suggestedRequestFields(intent)).toContainEqual(SELECTION_FIELD);
    }
  });

  it("does not make the chosen item required — the server writes it, not the visitor", () => {
    expect(SELECTION_FIELD.required).toBe(false);
    expect(SELECTION_FIELD.type).toBe("text");
  });
});

describe("requestEntityName", () => {
  it("names the second list after whatever the first one is", () => {
    expect(requestEntityName("Boats")).toBe("Boats requests");
    expect(requestEntityName("Rehearsal rooms")).toBe("Rehearsal rooms requests");
  });

  it("falls back to something sayable when nothing has been typed", () => {
    expect(requestEntityName("  ")).toBe("Requests");
  });
});
