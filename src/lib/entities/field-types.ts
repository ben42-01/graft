/**
 * Field types the in-app entity builder offers, with human labels, plus the
 * key derivation both it and any later builder should share.
 *
 * Declared here rather than imported from `src/server/services/entities.ts`
 * for the same reason `@/lib/widgets/types` mirrors `WidgetConfig`: that
 * module reaches for mongodb and cannot cross into a `"use client"` tree.
 * `field-types.test.ts` pins these against the server's `FIELD_TYPES`.
 */

/** `file` is deliberately not offered: uploads require a signed-URL
 * mechanism (docs/BACKEND.md §4) that does not exist anywhere in this
 * codebase yet, so a file field would be a column nothing can ever fill. */
export const UNOFFERED_FIELD_TYPES = ["file"] as const;

export const FIELD_TYPE_OPTIONS = [
  { type: "text", label: "Text" },
  { type: "number", label: "Number" },
  { type: "date", label: "Date" },
  { type: "select", label: "Choice list" },
  { type: "checkbox", label: "Yes / no" },
  { type: "email", label: "Email" },
  { type: "phone", label: "Phone" },
] as const;

export type OfferedFieldType = (typeof FIELD_TYPE_OPTIONS)[number]["type"];

/**
 * A label turned into the identifier the server requires: lowercase letters,
 * digits and underscores, starting with a letter (`fieldDefSchema.key` /
 * `createEntitySchema.key`). Ends up in a Mongo path, so anything outside
 * that alphabet is dropped rather than escaped.
 */
export function toIdentifier(input: string, max = 64): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+/g, "_")
    .replace(/_$/, "");
  return cleaned.slice(0, max);
}
