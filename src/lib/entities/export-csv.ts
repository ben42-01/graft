/**
 * An entity's records as a CSV the import wizard can read back.
 *
 * Built in the browser from the records endpoint, for the same reason the
 * account export is (src/lib/account-export.ts): it reads exactly what the
 * signed-in user can already read, and adds no new tenant-wide read path.
 *
 * With no records it is a template — the header row alone — so a person can
 * fill it in and import it. That is why the headers must round-trip:
 * `initialMapping` (import-mapping.tsx) matches a column to a field by label
 * or key, so a label is used unless two fields share one, in which case the
 * key is, so no column is ever left unmapped by the import's first-claim rule.
 * Image fields are left out: their value is a media id an upload owns, and the
 * import wizard does not offer them as a target.
 */
import { isImageField, type FieldLike } from "@/lib/entities/record-values";

const PAGE_LIMIT = 100;
const MAX_PAGES = 100;

/** The columns an export carries, in field order, with their header text. */
export function exportColumns(
  fields: readonly FieldLike[],
): { field: FieldLike; header: string }[] {
  const columns = fields.filter((field) => !isImageField(field));
  const labelCounts = new Map<string, number>();
  for (const field of columns) {
    const label = field.label.trim().toLowerCase();
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  return columns.map((field) => ({
    field,
    header:
      (labelCounts.get(field.label.trim().toLowerCase()) ?? 0) > 1
        ? field.key
        : field.label.trim() || field.key,
  }));
}

/**
 * One cell, quoted when it has to be. A text value that starts with a spreadsheet
 * formula character is prefixed with an apostrophe so opening the file in Excel
 * cannot run something a customer typed into a form; numbers are written bare,
 * since a negative number is not a formula.
 */
export function csvCell(value: unknown, field: FieldLike): string {
  if (value === undefined || value === null) return "";
  let text: string;
  if (typeof value === "boolean") text = value ? "Yes" : "No";
  else if (typeof value === "number") return String(value);
  else if (field.type === "date") text = String(value).slice(0, 10);
  else text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvHeaderCell(header: string): string {
  return /[",\r\n]/.test(header) ? `"${header.replace(/"/g, '""')}"` : header;
}

export function recordsToCsv(
  fields: readonly FieldLike[],
  records: readonly { data: Record<string, unknown> }[],
): string {
  const columns = exportColumns(fields);
  const lines = [columns.map((column) => csvHeaderCell(column.header)).join(",")];
  for (const record of records) {
    lines.push(columns.map(({ field }) => csvCell(record.data[field.key], field)).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** A filename-safe form of an entity's key. */
export const exportFilename = (entityKey: string, template: boolean): string =>
  `${entityKey.replace(/[^a-z0-9_-]+/gi, "-")}${template ? "-template" : ""}.csv`;

/** Every record of an entity, following the API's cursor. Null if a request fails. */
export async function fetchAllRecords(
  entityId: string,
): Promise<{ data: Record<string, unknown> }[] | null> {
  const records: { data: Record<string, unknown> }[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = `limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    try {
      const response = await fetch(`/api/v1/entities/${entityId}/records?${query}`, {
        credentials: "include",
      });
      if (!response.ok) return null;
      const body = (await response.json()) as {
        data: { data: Record<string, unknown> }[];
        meta?: { hasMore: boolean; cursor: string | null };
      };
      records.push(...body.data);
      if (!body.meta?.hasMore || !body.meta.cursor) return records;
      cursor = body.meta.cursor;
    } catch {
      return null;
    }
  }
  return null;
}
