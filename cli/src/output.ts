/**
 * How results look. `--json` prints the response's `data` exactly as the API
 * sent it (what scripts and the Graft skill read); otherwise lists become a
 * table of the columns that identify a row, and single objects a key: value
 * listing. Nothing here decides *what* to show — only how.
 */
export type Writer = { out: (s: string) => void; err: (s: string) => void; color: boolean };

export const stdio = (): Writer => ({
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
  color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
});

const paint = (w: Writer, code: number, s: string) =>
  w.color ? `\x1b[${code}m${s}\x1b[0m` : s;
export const bold = (w: Writer, s: string) => paint(w, 1, s);
export const dim = (w: Writer, s: string) => paint(w, 2, s);
export const green = (w: Writer, s: string) => paint(w, 32, s);
export const red = (w: Writer, s: string) => paint(w, 31, s);
export const yellow = (w: Writer, s: string) => paint(w, 33, s);

/** Columns worth a place in a table, in the order people look for them. */
const PREFERRED = [
  "id",
  "_id",
  "key",
  "slug",
  "name",
  "title",
  "label",
  "email",
  "status",
  "tier",
  "role",
  "roles",
  "total",
  "totalMinor",
  "currency",
  "createdAt",
  "updatedAt",
];
const MAX_COLUMNS = 7;
const MAX_CELL = 40;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

export function cell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.every((v) => typeof v !== "object") ? value.join(", ") : `[${value.length}]`;
  }
  return "{…}";
}

const clip = (s: string, n = MAX_CELL) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function pickColumns(rows: Record<string, unknown>[]): string[] {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const scalar = (k: string) =>
    rows.some((r) => r[k] !== null && r[k] !== undefined && !isPlain(r[k]));
  const preferred = PREFERRED.filter((k) => keys.includes(k));
  const others = keys.filter((k) => !preferred.includes(k) && scalar(k));
  return [...preferred, ...others].slice(0, MAX_COLUMNS);
}

export function table(rows: Record<string, unknown>[], w: Writer): string {
  if (rows.length === 0) return dim(w, "(none)");
  const cols = pickColumns(rows);
  const cells = rows.map((r) => cols.map((c) => clip(cell(r[c]))));
  const widths = cols.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i].length)));
  const line = (vals: string[]) =>
    vals
      .map((v, i) => v.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  return [bold(w, line(cols)), ...cells.map(line)].join("\n");
}

export function keyValues(obj: Record<string, unknown>, w: Writer, indent = ""): string {
  const width = Math.max(0, ...Object.keys(obj).map((k) => k.length));
  return Object.entries(obj)
    .map(([k, v]) => {
      if (isPlain(v) && Object.keys(v).length > 0)
        return `${indent}${dim(w, k)}\n${keyValues(v, w, indent + "  ")}`;
      if (Array.isArray(v) && v.some(isPlain))
        return `${indent}${dim(w, k)}  ${dim(w, `[${v.length} items — use --json]`)}`;
      return `${indent}${dim(w, k.padEnd(width))}  ${cell(v)}`;
    })
    .join("\n");
}

export function render(data: unknown, w: Writer, json: boolean): string {
  if (json) return JSON.stringify(data, null, 2);
  if (data === null || data === undefined) return green(w, "done");
  if (Array.isArray(data))
    return data.every(isPlain)
      ? table(data as Record<string, unknown>[], w)
      : data.map(cell).join("\n");
  if (isPlain(data)) {
    // `{ items: [...] }` style payloads read best as their list.
    const lists = Object.entries(data).filter(
      ([, v]) => Array.isArray(v) && (v as unknown[]).every(isPlain),
    );
    if (lists.length === 1 && Object.keys(data).length <= 2)
      return table(lists[0][1] as Record<string, unknown>[], w);
    return keyValues(data, w);
  }
  return cell(data);
}
