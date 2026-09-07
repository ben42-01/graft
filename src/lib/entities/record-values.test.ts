/**
 * The form-value/record-data conversion. What matters is that it produces
 * exactly what the compiled record schema accepts: typed values, optional
 * blanks omitted rather than sent empty, and required blanks caught here
 * with the field's own label rather than as a 400 from the server.
 */
import { describe, expect, it } from "vitest";
import {
  emptyFormValues,
  formatCell,
  formValuesFrom,
  toRecordPayload,
  type FieldLike,
} from "./record-values";

const FIELDS: FieldLike[] = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "email", label: "Email", type: "email" },
  { key: "age", label: "Age", type: "number" },
  { key: "due", label: "Due", type: "date" },
  { key: "status", label: "Status", type: "select", options: ["New", "Done"] },
  { key: "active", label: "Active", type: "checkbox" },
];

describe("emptyFormValues", () => {
  it("starts checkboxes false and everything else blank", () => {
    expect(emptyFormValues(FIELDS)).toEqual({
      name: "",
      email: "",
      age: "",
      due: "",
      status: "",
      active: false,
    });
  });
});

describe("toRecordPayload", () => {
  it("types each value the way the compiled schema expects", () => {
    const result = toRecordPayload(
      {
        name: " Ada ",
        email: "ada@example.test",
        age: "36",
        due: "2026-09-01",
        status: "New",
        active: true,
      },
      FIELDS,
    );

    expect(result).toEqual({
      ok: true,
      data: {
        name: "Ada",
        email: "ada@example.test",
        age: 36,
        due: "2026-09-01",
        status: "New",
        active: true,
      },
    });
  });

  it("omits blank optionals rather than sending an empty string", () => {
    const result = toRecordPayload(emptyFormValues([...FIELDS.slice(1)]), FIELDS.slice(1));
    expect(result).toEqual({ ok: true, data: {} });
  });

  it("names the required field that is blank", () => {
    const values = { ...emptyFormValues(FIELDS), email: "ada@example.test" };
    expect(toRecordPayload(values, FIELDS)).toEqual({
      ok: false,
      message: "Name is required.",
    });
  });

  it("rejects a number that isn't one", () => {
    const values = { ...emptyFormValues(FIELDS), name: "Ada", age: "twelve" };
    expect(toRecordPayload(values, FIELDS)).toEqual({
      ok: false,
      message: "Age must be a number.",
    });
  });

  it("sends a required checkbox even when false", () => {
    const fields: FieldLike[] = [
      { key: "agreed", label: "Agreed", type: "checkbox", required: true },
    ];
    expect(toRecordPayload({ agreed: false }, fields)).toEqual({
      ok: true,
      data: { agreed: false },
    });
  });
});

describe("formValuesFrom", () => {
  it("round-trips a stored record back into the form", () => {
    const stored = {
      name: "Ada",
      age: 36,
      due: "2026-09-01T00:00:00.000Z",
      active: true,
    };

    expect(formValuesFrom(stored, FIELDS)).toEqual({
      name: "Ada",
      email: "",
      age: "36",
      due: "2026-09-01",
      status: "",
      active: true,
    });
  });
});

describe("formatCell", () => {
  it("renders each type as a human would read it", () => {
    expect(formatCell(undefined, FIELDS[0])).toBe("—");
    expect(formatCell(true, FIELDS[5])).toBe("Yes");
    expect(formatCell(false, FIELDS[5])).toBe("No");
    expect(formatCell(1234, FIELDS[2])).toBe("1,234");
    expect(formatCell("not a date", FIELDS[3])).toBe("not a date");
  });
});
