/**
 * The field-editing rules the UI enforces before it will POST or PATCH —
 * they mirror `fieldDefSchema` (src/server/services/entities.ts), so this
 * covers the mirror, not the server.
 */
import { describe, expect, it } from "vitest";
import {
  draftFieldsFrom,
  initialDraftFields,
  newDraftField,
  patchDraftField,
  removedKeys,
  splitOptions,
  toFieldPayload,
  validateFields,
} from "./draft-fields";

describe("validateFields", () => {
  it("accepts a well-formed set", () => {
    expect(validateFields(initialDraftFields())).toBeNull();
  });

  it("rejects an empty set, an unlabelled field and a duplicate key", () => {
    expect(validateFields([])).toBe("Add at least one field.");
    expect(validateFields([{ ...newDraftField("Name"), label: "" }])).toBe(
      "Every field needs a label.",
    );
    expect(validateFields([newDraftField("Name"), newDraftField("Name")])).toContain(
      'share the key "name"',
    );
  });

  it("requires options for a choice list", () => {
    expect(validateFields([newDraftField("Status", "select")])).toContain(
      "needs at least one option",
    );
    const withOptions = { ...newDraftField("Status", "select"), options: "New, Done" };
    expect(validateFields([withOptions])).toBeNull();
  });

  it("rejects a required picture — it is uploaded after the record exists", () => {
    const image = { ...newDraftField("Photo"), type: "image" as const, required: true };
    expect(validateFields([image])).toBe(
      '"Photo" is a picture, so it cannot be required — it is added after the record is created.',
    );
    expect(validateFields([{ ...image, required: false }])).toBeNull();
  });

  it("rejects a label that leaves no usable key", () => {
    expect(validateFields([newDraftField("!!!")])).toContain("needs a key");
  });
});

describe("patchDraftField", () => {
  it("keeps the key in step with the label until the key is taken over", () => {
    const field = newDraftField("Name");
    const relabelled = patchDraftField(field, { label: "Full name" });
    expect(relabelled.key).toBe("full_name");

    const taken = patchDraftField(relabelled, { key: "surname", keyEdited: true });
    expect(patchDraftField(taken, { label: "Family name" }).key).toBe("surname");
  });
});

describe("patchDraftField — image fields", () => {
  it("drops a required flag when a field is retyped to a picture", () => {
    const required = { ...newDraftField("Photo"), required: true };
    expect(patchDraftField(required, { type: "image" }).required).toBe(false);
  });

  it("leaves the flag alone for every other type", () => {
    const required = { ...newDraftField("Name"), required: true };
    expect(patchDraftField(required, { type: "text" }).required).toBe(true);
  });
});

describe("draftFieldsFrom — legacy entities", () => {
  it("clears a required flag stored on an image before the rule existed", () => {
    const [row] = draftFieldsFrom([
      { key: "photo", label: "Photo", type: "image", required: true },
    ]);
    expect(row?.required).toBe(false);
    expect(validateFields([row!])).toBeNull();
  });
});

describe("toFieldPayload", () => {
  it("sends options only for a choice list, and trims labels", () => {
    const text = { ...newDraftField("Name"), label: "  Name  " };
    const choice = { ...newDraftField("Status", "select"), options: " New , Done ,, " };

    expect(toFieldPayload([text, choice])).toEqual([
      { key: "name", label: "Name", type: "text", required: false },
      {
        key: "status",
        label: "Status",
        type: "select",
        required: false,
        options: ["New", "Done"],
      },
    ]);
  });
});

describe("draftFieldsFrom / removedKeys", () => {
  it("round-trips a saved entity's fields back into a payload", () => {
    const saved = [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "status", label: "Status", type: "select", required: false, options: ["A", "B"] },
    ];

    expect(toFieldPayload(draftFieldsFrom(saved))).toEqual(saved);
  });

  it("names the keys a save would orphan", () => {
    const saved = [{ key: "name" }, { key: "phone" }];
    const draft = draftFieldsFrom([{ key: "name", label: "Name", type: "text" }]);
    expect(removedKeys(saved, draft)).toEqual(["phone"]);
  });
});

describe("splitOptions", () => {
  it("drops blanks and surrounding whitespace", () => {
    expect(splitOptions(" a , , b ,")).toEqual(["a", "b"]);
  });
});
