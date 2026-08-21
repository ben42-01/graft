/**
 * Turning an entity's field definitions into form values and back.
 *
 * The record API takes and returns the record's `data` object directly, and
 * validates it against a Zod schema compiled from the entity's fields
 * (`compileFieldSchema`, src/server/services/entities.ts). That schema is
 * `.strict()` and typed: a number field wants a real number, a checkbox a
 * boolean, a date something `z.coerce.date()` accepts. HTML inputs only ever
 * hand back strings, so something has to do the conversion — this does, in
 * one pure place, rather than scattered through a form component.
 *
 * Optional fields left blank are *omitted* rather than sent as `""`: an
 * empty string fails an `email()` or an enum, and the compiled schema marks
 * an optional field `.optional()`, which means absent, not empty.
 */
export type FieldLike = {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  options?: string[];
};

/** What an input holds: a string for everything except a checkbox. */
export type FormValue = string | boolean;
export type FormValues = Record<string, FormValue>;

export function emptyFormValues(fields: readonly FieldLike[]): FormValues {
  const values: FormValues = {};
  for (const field of fields) values[field.key] = field.type === "checkbox" ? false : "";
  return values;
}

/** An existing record's stored data, as form values. */
export function formValuesFrom(
  data: Record<string, unknown>,
  fields: readonly FieldLike[],
): FormValues {
  const values = emptyFormValues(fields);
  for (const field of fields) {
    const value = data[field.key];
    if (value === undefined || value === null) continue;
    if (field.type === "checkbox") values[field.key] = value === true;
    // Dates come back as ISO strings; `<input type="date">` wants YYYY-MM-DD.
    else if (field.type === "date") values[field.key] = String(value).slice(0, 10);
    else values[field.key] = String(value);
  }
  return values;
}

export type PayloadResult =
  { ok: true; data: Record<string, unknown> } | { ok: false; message: string };

export function toRecordPayload(
  values: FormValues,
  fields: readonly FieldLike[],
): PayloadResult {
  const data: Record<string, unknown> = {};

  for (const field of fields) {
    const raw = values[field.key];

    if (field.type === "checkbox") {
      // A false checkbox is a real value, not an absent one — but an
      // optional unchecked box is left out so it doesn't invent data.
      if (raw === true || field.required) data[field.key] = raw === true;
      continue;
    }

    const text = typeof raw === "string" ? raw.trim() : "";
    if (text === "") {
      if (field.required) return { ok: false, message: `${field.label} is required.` };
      continue;
    }

    if (field.type === "number") {
      const parsed = Number(text);
      if (!Number.isFinite(parsed))
        return { ok: false, message: `${field.label} must be a number.` };
      data[field.key] = parsed;
      continue;
    }

    data[field.key] = text;
  }

  return { ok: true, data };
}

/** One stored value as table-cell text. */
export function formatCell(value: unknown, field: FieldLike): string {
  if (value === undefined || value === null || value === "") return "—";
  if (field.type === "checkbox") return value === true ? "Yes" : "No";
  if (field.type === "date") {
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString();
  }
  if (field.type === "number") return Number(value).toLocaleString();
  return String(value);
}
