"use client";

/**
 * Step two of the record import wizard (GRAFT-25.2): which column of the
 * tenant's file goes into which field of the entity.
 *
 * Three rules, each an acceptance criterion:
 *
 *   - **Targets are the entity's real fields** (AC2), read from the entity
 *     definition the page already loaded. Image fields are not offered: their
 *     value is a media id written by an upload, never a cell in a file.
 *   - **Every column is decided** — mapped to exactly one field, or skipped.
 *     The mapping names every detected column, a skip as `null`, so the server
 *     never falls back to reading a column as the field of the same name.
 *   - **A required field nothing maps to blocks the step, by name** (AC3).
 *
 * Column detection mirrors the server's parser (`parseImportFile` in
 * src/server/services/imports.ts) for the one thing this step needs — the
 * names. Headers are trimmed there, so they are trimmed here; a mapping keyed
 * on a name the server spells differently would silently map nothing.
 */
import type { FieldLike } from "@/lib/entities/record-values";
import { isImageField } from "@/lib/entities/record-values";

export type ImportFormat = "csv" | "json";

/** Column name → field key, or `null` for "skip this column". */
export type ColumnMapping = Record<string, string | null>;

/** How many JSON records are sampled for keys. The server reads every record;
 * this only decides which columns the mapping step lists. */
const JSON_SAMPLE = 50;

export function formatOf(file: { name: string; type: string }): ImportFormat | null {
  const name = file.name.toLowerCase();
  if (file.type === "application/json" || name.endsWith(".json")) return "json";
  if (file.type === "text/csv" || name.endsWith(".csv")) return "csv";
  return null;
}

/** The first row of a CSV, by the server's quoting rules: a quote opens a cell
 * only at its start, `""` is a literal quote, and the row ends at an unquoted
 * newline. */
function csvHeader(text: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else quoted = false;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else if (ch === "\n") break;
    else if (ch !== "\r") cell += ch;
  }
  cells.push(cell);
  return cells;
}

export function detectColumns(
  text: string,
  format: ImportFormat,
): { columns: string[] } | { error: string } {
  if (format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { error: "This JSON file could not be read." };
    }
    if (!Array.isArray(parsed)) {
      return { error: "A JSON import must be a list of records, like [ {…}, {…} ]." };
    }
    const seen = new Set<string>();
    for (const entry of parsed.slice(0, JSON_SAMPLE)) {
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
        for (const key of Object.keys(entry)) seen.add(key);
      }
    }
    return seen.size > 0
      ? { columns: [...seen] }
      : { error: "This JSON file has no records with values in them." };
  }

  // A blank header cannot be named in a mapping at all, so it is not listed.
  const columns = [
    ...new Set(
      csvHeader(text)
        .map((cell) => cell.trim())
        .filter(Boolean),
    ),
  ];
  return columns.length > 0
    ? { columns }
    : { error: "This CSV file has no header row. Its first line should name each column." };
}

/** The fields a column can be mapped into. */
export const mappableFields = (fields: readonly FieldLike[]): FieldLike[] =>
  fields.filter((field) => !isImageField(field));

/** A column whose name is a field's key or label starts mapped to it; the rest
 * start skipped. The first column to claim a field keeps it. */
export function initialMapping(
  columns: readonly string[],
  fields: readonly FieldLike[],
): ColumnMapping {
  const targets = mappableFields(fields);
  const mapping: ColumnMapping = {};
  const taken = new Set<string>();
  for (const column of columns) {
    const wanted = column.toLowerCase();
    const match = targets.find(
      (field) =>
        !taken.has(field.key) &&
        (field.key.toLowerCase() === wanted || field.label.toLowerCase() === wanted),
    );
    mapping[column] = match?.key ?? null;
    if (match) taken.add(match.key);
  }
  return mapping;
}

/** One column to one field: giving a field to this column takes it away from
 * whichever column had it, which is then skipped. */
export function setColumnTarget(
  mapping: ColumnMapping,
  column: string,
  target: string | null,
): ColumnMapping {
  const next: ColumnMapping = {};
  for (const [name, current] of Object.entries(mapping)) {
    next[name] = target !== null && name !== column && current === target ? null : current;
  }
  next[column] = target;
  return next;
}

export function missingRequired(
  mapping: ColumnMapping,
  fields: readonly FieldLike[],
): FieldLike[] {
  const used = new Set(Object.values(mapping));
  return mappableFields(fields).filter((field) => field.required && !used.has(field.key));
}

const SELECT_CLASS =
  "w-full rounded-md border bg-background px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-graft-green focus-visible:outline-none";

export function ImportMapping({
  columns,
  fields,
  mapping,
  onChange,
  dedupeKey,
  onDedupeKeyChange,
}: {
  columns: readonly string[];
  fields: readonly FieldLike[];
  mapping: ColumnMapping;
  onChange: (mapping: ColumnMapping) => void;
  dedupeKey: string | null;
  onDedupeKeyChange: (key: string | null) => void;
}) {
  const targets = mappableFields(fields);
  const missing = missingRequired(mapping, fields);
  const used = new Set(Object.values(mapping));
  const mapped = targets.filter((field) => used.has(field.key));

  return (
    <div className="flex flex-col gap-4">
      <div className="max-h-72 overflow-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Column in your file</th>
              <th className="px-3 py-2 font-medium">Goes into</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((column) => (
              <tr key={column} className="border-t">
                <td className="px-3 py-2 font-mono text-xs break-all">{column}</td>
                <td className="px-3 py-2">
                  {/* Native, not Radix: a mapping table can hold dozens of
                   * these, and each one is a plain choice from a short list. */}
                  <select
                    aria-label={`Field for column ${column}`}
                    value={mapping[column] ?? ""}
                    onChange={(event) =>
                      onChange(setColumnTarget(mapping, column, event.target.value || null))
                    }
                    className={SELECT_CLASS}
                  >
                    <option value="">Skip this column</option>
                    {targets.map((field) => (
                      <option key={field.key} value={field.key}>
                        {field.label}
                        {field.required ? " (required)" : ""}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        Each field takes one column. Choosing a field another column already uses moves it here,
        and that column is skipped.
      </p>

      {missing.length > 0 ? (
        <ul
          role="alert"
          className="flex flex-col gap-1 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
        >
          {missing.map((field) => (
            <li key={field.key}>{field.label} is required. Choose the column it comes from.</li>
          ))}
        </ul>
      ) : null}

      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Duplicate check</span>
        <select
          value={dedupeKey !== null && used.has(dedupeKey) ? dedupeKey : ""}
          onChange={(event) => onDedupeKeyChange(event.target.value || null)}
          className={SELECT_CLASS}
        >
          <option value="">Don&apos;t check for duplicates</option>
          {mapped.map((field) => (
            <option key={field.key} value={field.key}>
              Skip rows whose {field.label} already exists
            </option>
          ))}
        </select>
        <span className="text-muted-foreground">
          An import only ever adds records. It never changes one you already have.
        </span>
      </label>
    </div>
  );
}
