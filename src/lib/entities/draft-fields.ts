/**
 * The editable representation of an entity's fields, shared by the "New
 * entity" dialog and the schema editor on an entity's page.
 *
 * A `DraftField` is not a `FieldDef`: it carries a stable local row id (so
 * React keys survive a key rename), a `keyEdited` flag (a key tracks its
 * label until the user takes it over), and `options` as the raw
 * comma-separated string the input holds. `toFieldPayload` is the one place
 * that turns drafts back into what the API accepts.
 *
 * Pure — no React, no fetch — so the rules the UI enforces are unit-testable
 * on their own, which matters because they mirror `createEntitySchema` /
 * `updateEntitySchema` (src/server/services/entities.ts) and drift silently
 * if nobody is watching.
 */
import { toIdentifier, type OfferedFieldType } from "./field-types";

export type DraftField = {
  /** Local row identity — never sent; `key` is what the server stores. */
  rowId: string;
  label: string;
  key: string;
  /** True once the user edits the key by hand, which stops label-tracking. */
  keyEdited: boolean;
  type: OfferedFieldType;
  required: boolean;
  /** Comma-separated while editing; split by `toFieldPayload`. `select` only. */
  options: string;
  /** True for a field that already exists on the saved entity. Removing one
   * drops that column's data on the next write (records.ts migrates lazily,
   * dropping only what the definition no longer has), so the editor warns. */
  persisted: boolean;
};

export type FieldPayload = {
  key: string;
  label: string;
  type: OfferedFieldType;
  required: boolean;
  options?: string[];
};

let rowCounter = 0;

export function newDraftField(label = "", type: OfferedFieldType = "text"): DraftField {
  return {
    rowId: `row-${(rowCounter += 1)}`,
    label,
    key: toIdentifier(label),
    keyEdited: false,
    type,
    required: false,
    options: "",
    persisted: false,
  };
}

/** Every entity starts with one required text field — an entity with no
 * fields is invalid server-side, and "Name" is the near-universal first one. */
export function initialDraftFields(): DraftField[] {
  return [{ ...newDraftField("Name"), required: true }];
}

/**
 * Field definitions as editable rows. `persisted` says whether these are a
 * saved entity's fields (keys locked — records are stored under them) or a
 * starting point being copied in, such as an entity template, where nothing
 * is committed yet and every key is still free to change.
 */
export function draftFieldsFrom(
  fields: readonly {
    key: string;
    label: string;
    type: string;
    required?: boolean;
    options?: string[];
  }[],
  persisted = true,
): DraftField[] {
  return fields.map((field) => ({
    rowId: `row-${(rowCounter += 1)}`,
    label: field.label,
    key: field.key,
    keyEdited: true,
    type: field.type as OfferedFieldType,
    required: field.required ?? false,
    options: field.options?.join(", ") ?? "",
    persisted,
  }));
}

export function splitOptions(value: string): string[] {
  return value
    .split(",")
    .map((option) => option.trim())
    .filter((option) => option.length > 0);
}

/** Applies a patch to one row, keeping the key in step with the label until
 * the user has taken the key over. */
export function patchDraftField(field: DraftField, patch: Partial<DraftField>): DraftField {
  const next = { ...field, ...patch };
  if (patch.label !== undefined && !next.keyEdited) next.key = toIdentifier(patch.label);
  return next;
}

/**
 * The first reason these fields would be refused, in the user's terms, or
 * `null` when they are ready to send. Mirrors `fieldDefSchema`.
 */
export function validateFields(fields: DraftField[]): string | null {
  if (fields.length === 0) return "Add at least one field.";

  const seen = new Set<string>();
  for (const field of fields) {
    if (!field.label.trim()) return "Every field needs a label.";
    if (!field.key) return `"${field.label}" needs a key — letters, digits and underscores.`;
    if (seen.has(field.key)) return `Two fields share the key "${field.key}".`;
    seen.add(field.key);
    if (field.type === "select" && splitOptions(field.options).length === 0) {
      return `"${field.label}" is a choice list, so it needs at least one option.`;
    }
  }
  return null;
}

export function toFieldPayload(fields: DraftField[]): FieldPayload[] {
  return fields.map((field) => ({
    key: field.key,
    label: field.label.trim(),
    type: field.type,
    required: field.required,
    ...(field.type === "select" ? { options: splitOptions(field.options) } : {}),
  }));
}

/** Keys present on the saved entity that this draft no longer has — the data
 * a save would orphan, which the editor names rather than silently dropping. */
export function removedKeys(saved: readonly { key: string }[], draft: DraftField[]): string[] {
  const kept = new Set(draft.map((field) => field.key));
  return saved.map((field) => field.key).filter((key) => !kept.has(key));
}
