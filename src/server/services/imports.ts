/**
 * Batch record import — CSV and JSON (GRAFT-25.1, docs/TIERS.md §2.3,
 * docs/BACKEND.md §1, §4).
 *
 * The first enforcement of the `csv_import` entitlement, and the first place a
 * tenant can create many records in one request. Five properties are load
 * bearing, and each is an acceptance criterion:
 *
 *   - **Target field names come from `entity_defs`, never from the file.** A
 *     column header is a *source* name; the mapping turns it into a target,
 *     and a target that is not one of the entity's own field keys is refused —
 *     as a 400 when the mapping says it, as a row rejection when the file does.
 *     So a crafted header (`isAdmin`, `$where`, `__proto__`) cannot put an
 *     unmapped key into Mongo; there is no path from a header to a stored key
 *     that does not pass through the entity definition (AC3).
 *   - **`null` is unlimited and is branched on, never coalesced.** Enterprise
 *     carries `records: null`, which is what makes its per-import row cap
 *     absent rather than zero (AC2) — a `?? 0` here would refuse every
 *     Enterprise import with "0 rows allowed".
 *   - **A bad row rejects that row, not the file** (AC4). Parsing is per row
 *     and collects reasons; only a file that cannot be parsed *at all*, or a
 *     mapping that names a field the entity does not have, fails whole.
 *   - **The records ceiling produces a partial import, reported as such**
 *     (AC8). `checkQuota` reserves atomically, so the refusal it returns
 *     carries the real remaining headroom; the import then reserves exactly
 *     that much and rejects the overflow with a reason naming the meter.
 *     Nothing is silently truncated and nothing is written unreserved.
 *   - **This contract inserts. It never updates** (AC7). A row that duplicates
 *     a stored record under the dedupe key is a rejection, so an import can
 *     never overwrite data a tenant already has.
 *
 * Rows are inserted one at a time through the repository layer rather than in
 * one `insertMany`: the repository (src/server/repositories/base.ts) is the
 * only thing that injects `ctx.tenantId`, it is a protected path, and a batch
 * write that reached past it to the driver would be exactly the bypass the
 * isolation boundary exists to prevent.
 */
import { ObjectId, type Filter } from "mongodb";
import { z } from "zod";
import type { Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import { createLogger, type Logger } from "@/server/log";
import { createRepository, type Repository } from "@/server/repositories/base";
import {
  getCompiledSchema,
  getEntity as getEntityDefault,
  type EntityView,
  type FieldDef,
} from "./entities";
import {
  can as canDefault,
  limitFor,
  loadEntitlements,
  type Entitlements,
} from "./entitlements";
import {
  confirmUpload as confirmUploadDefault,
  readImportText,
  requestImportUploadSchema,
  requestUpload as requestUploadDefault,
  type MediaView,
  type RequestAnyUploadInput,
  type UploadTicket,
} from "./media";
import {
  checkQuota as checkQuotaDefault,
  peekQuota as peekQuotaDefault,
  type Meter,
  type QuotaResult,
} from "./meters";
import type { RecordDoc } from "./records";

const objectIdHex = z.string().regex(/^[0-9a-f]{24}$/i, "Expected a 24-character id");

/** The same alphabet a field key is created under (entities.ts). */
const fieldKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "Not a field key")
  .max(64);

export const IMPORT_FORMATS = ["csv", "json"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

/**
 * The one-to-one map between a declared `format` and the stored object's
 * `contentType` (`ALLOWED_IMPORT_TYPES` in media.ts). The upload's content
 * type is the more trustworthy of the two — it was fixed at upload time and
 * cannot be changed by this request — so a mismatch is refused rather than
 * silently trusting the client-declared `format`.
 */
const CONTENT_TYPE_FOR_FORMAT: Record<ImportFormat, string> = {
  csv: "text/csv",
  json: "application/json",
};

/**
 * docs/TIERS.md §2.3 — "✓ 10k rows/import" on Premium, "Unlimited" on
 * Enterprise. Not a `TIER_LIMITS` key: the tier matrix counts what a tenant may
 * *hold*, and this bounds one request. See `rowLimitFor` for how the tiers are
 * told apart without inventing a new limit.
 */
export const ROWS_PER_IMPORT = 10_000;

/**
 * How many rejections are kept on the stored result. A 10,000-row file can
 * reject 10,000 times, and a Mongo document that grows with the tenant's
 * mistakes is a 16 MB cliff waiting to happen. `rejectedCount` is always the
 * true total.
 */
export const MAX_STORED_REJECTIONS = 500;

export const importParamSchema = z.object({ entityId: objectIdHex });
export const importResultParamSchema = z.object({
  entityId: objectIdHex,
  importId: objectIdHex,
});

export const startImportSchema = z.object({
  mediaId: objectIdHex,
  format: z.enum(IMPORT_FORMATS),
  /**
   * Source column name → target field key. A source with no entry maps to
   * itself, which is what makes a file whose headers already match the entity
   * importable with `{}`. The *target* is what is validated against
   * `entity_defs`; the source is never trusted for anything but lookup.
   *
   * `null` skips the column: its cells are never read. Without it a file with
   * one column the entity lacks (`notes`) rejected every row, and a column
   * named like a field could not be left out at all (GRAFT-25.2 wizard).
   */
  mapping: z
    .record(z.string().min(1).max(200), z.string().min(1).max(64).nullable())
    .default({}),
  dedupeKey: fieldKey.nullish(),
  dryRun: z.boolean().default(false),
});

export type StartImportInput = z.input<typeof startImportSchema>;

export type RejectedRow = { row: number; reason: string; field?: string };

export type ImportResult = {
  importId: string;
  dryRun: boolean;
  format: ImportFormat;
  total: number;
  imported: number;
  rejected: RejectedRow[];
  /** The true count; `rejected` is capped at `MAX_STORED_REJECTIONS`. */
  rejectedCount: number;
  /** AC6 — states in the result that no dedupe was performed. */
  dedupe: { key: string | null; applied: boolean };
  quota: { meter: Meter; remaining: number | null };
};

export type ImportDoc = {
  tenantId: ObjectId;
  entityDefId: ObjectId;
  mediaId: ObjectId;
  format: ImportFormat;
  dryRun: boolean;
  total: number;
  imported: number;
  rejected: RejectedRow[];
  rejectedCount: number;
  dedupeKey: string | null;
  quotaRemaining: number | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ImportDeps = {
  repo: Repository<ImportDoc>;
  records: Repository<RecordDoc>;
  getEntity: (ctx: Ctx, entityId: string) => Promise<EntityView>;
  entitlements: (ctx: Ctx) => Promise<Entitlements>;
  can: (ctx: Ctx, feature: "csv_import") => Promise<boolean>;
  readFile: (ctx: Ctx, mediaId: string) => Promise<{ text: string; contentType: string }>;
  checkQuota: (ctx: Ctx, meter: Meter, amount: number) => Promise<QuotaResult>;
  peekQuota: (ctx: Ctx, meter: Meter) => Promise<QuotaResult>;
  requestUpload: (
    ctx: Ctx,
    owner: { type: "import"; id: string },
    input: RequestAnyUploadInput,
  ) => Promise<UploadTicket>;
  confirmUpload: (ctx: Ctx, mediaId: string) => Promise<MediaView>;
  log: Pick<Logger, "info">;
};

const defaultImportRepo = createRepository<ImportDoc>("imports");
const defaultRecordsRepo = createRepository<RecordDoc>("records");

function resolveDeps(overrides: Partial<ImportDeps> = {}): ImportDeps {
  // Each default is the real function by reference rather than a lambda that
  // forwards to it: a forwarding lambda is a second, untested code path that
  // exists only to be typed, and every one of them was invisible to the unit
  // suite (which passes overrides) while still being shipped.
  return {
    repo: overrides.repo ?? defaultImportRepo,
    records: overrides.records ?? defaultRecordsRepo,
    getEntity: overrides.getEntity ?? getEntityDefault,
    entitlements: overrides.entitlements ?? loadEntitlements,
    can: overrides.can ?? canDefault,
    readFile: overrides.readFile ?? readImportText,
    checkQuota: overrides.checkQuota ?? checkQuotaDefault,
    peekQuota: overrides.peekQuota ?? peekQuotaDefault,
    requestUpload: overrides.requestUpload ?? requestUploadDefault,
    confirmUpload: overrides.confirmUpload ?? confirmUploadDefault,
    log: overrides.log ?? createLogger({ service: "imports" }),
  };
}

/** AC1 — one gate, called by every entry point an import file can arrive through. */
async function assertMayImport(deps: ImportDeps, ctx: Ctx): Promise<void> {
  if (await deps.can(ctx, "csv_import")) return;
  throw new AppError(
    "FEATURE_NOT_AVAILABLE",
    "Batch import is not included in your plan. Upgrade to import records in bulk.",
    { feature: "csv_import" },
  );
}

const badBody = (fields: Record<string, string>) =>
  new AppError("VALIDATION_FAILED", "Invalid request body", { source: "body", fields });

/* ------------------------------------------------------------------ parsing */

/**
 * RFC 4180, minus the parts nobody sends: quoted cells, `""` escapes, commas
 * and newlines inside quotes, LF or CRLF line endings. Hand-written rather
 * than a dependency, because the grammar is this small and a parser is the
 * one place an import must not surprise anybody.
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let started = false;

  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      started = true;
      continue;
    }
    if (ch === ",") {
      endCell();
      started = true;
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      endRow();
      continue;
    }
    cell += ch;
    started = true;
  }

  if (quoted) {
    throw badBody({ "(file)": "The csv file has a quoted value that is never closed" });
  }
  if (started || cell !== "" || row.length) endRow();
  return rows;
}

/** One row of the file: either its raw source-keyed values, or why it is unusable. */
export type ParsedRow = { row: number; values?: Record<string, unknown>; error?: string };

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * AC10 — one code path for both formats: each produces the same
 * source-keyed rows, and everything downstream is format-blind. A file that
 * cannot be parsed at all is a 400 naming the format; a single unusable *row*
 * is a row error (AC4).
 */
export function parseImportFile(text: string, format: ImportFormat): ParsedRow[] {
  if (format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw badBody({ "(file)": "The json file could not be parsed" });
    }
    if (!Array.isArray(parsed)) {
      throw badBody({ "(file)": "The json file must be an array of records" });
    }
    return parsed.map((entry, index) =>
      isPlainRecord(entry)
        ? { row: index + 1, values: entry }
        : { row: index + 1, error: "Expected a JSON object" },
    );
  }

  const rows = parseCsvRows(text);
  const header = rows[0];
  if (!header || header.every((h) => h.trim() === "")) {
    throw badBody({ "(file)": "The csv file has no header row" });
  }
  const columns = header.map((h) => h.trim());
  return rows.slice(1).map((cells, index) => {
    const row = index + 1;
    if (cells.length !== columns.length) {
      return { row, error: `Expected ${columns.length} columns, got ${cells.length}` };
    }
    const values: Record<string, unknown> = {};
    columns.forEach((name, i) => {
      values[name] = cells[i];
    });
    return { row, values };
  });
}

/* ------------------------------------------------------------------- gating */

/**
 * AC2. Enterprise is exactly the tier whose `records` limit is `null`, and
 * `null` means unlimited — so it is branched on here and a number is returned
 * for everyone else. Coalescing `null` to `0` would refuse every Enterprise
 * import, which is the failure mode this shape exists to make impossible.
 */
export function rowLimitFor(entitlements: Entitlements): number | null {
  return limitFor(entitlements, "records") === null ? null : ROWS_PER_IMPORT;
}

/* ---------------------------------------------------------------- coercion */

const TRUE = new Set(["true", "yes", "y", "1"]);
const FALSE = new Set(["false", "no", "n", "0"]);

/**
 * A CSV cell is always text; a JSON value usually is not. Coercing both the
 * same way is what makes AC10's "byte-identical results" true rather than
 * approximately true. Anything that cannot be coerced is passed through
 * unchanged so the compiled schema — not this function — writes the reason.
 */
function coerceCell(raw: unknown, field: FieldDef): unknown {
  if (raw === undefined || raw === null) return undefined;
  const text = typeof raw === "string" ? raw.trim() : raw;
  if (text === "") return undefined;

  switch (field.type) {
    case "number": {
      if (typeof text === "number") return text;
      if (typeof text !== "string") return text;
      const num = Number(text);
      return Number.isFinite(num) ? num : text;
    }
    case "checkbox": {
      if (typeof text === "boolean") return text;
      if (typeof text !== "string") return text;
      const lower = text.toLowerCase();
      if (TRUE.has(lower)) return true;
      if (FALSE.has(lower)) return false;
      return text;
    }
    default:
      return text;
  }
}

/* ------------------------------------------------------------------ the run */

type Candidate = { row: number; data: Record<string, unknown> };

const quotaReason = (meter: Meter) =>
  `Your plan's "${meter}" limit was reached before this row — upgrade to import the rest`;

function assertMapping(
  mapping: Record<string, string | null>,
  dedupeKey: string | null,
  fields: readonly FieldDef[],
): void {
  const known = new Set(fields.map((f) => f.key));
  const errors: Record<string, string> = {};
  for (const [source, target] of Object.entries(mapping)) {
    if (target !== null && !known.has(target)) {
      errors[`mapping.${source}`] = `This entity has no field "${target}"`;
    }
  }
  if (dedupeKey !== null && !known.has(dedupeKey)) {
    errors.dedupeKey = `This entity has no field "${dedupeKey}"`;
  }
  if (Object.keys(errors).length) throw badBody(errors);
}

/**
 * AC3 — the only place a stored key is decided. Every key of the returned
 * object is a field key read off the entity definition; a source that resolves
 * to anything else rejects the row by name.
 */
function buildRow(
  parsed: ParsedRow,
  mapping: Record<string, string | null>,
  byKey: Map<string, FieldDef>,
  schema: z.ZodTypeAny,
): { data?: Record<string, unknown>; rejection?: RejectedRow } {
  if (parsed.values === undefined) {
    return { rejection: { row: parsed.row, reason: parsed.error ?? "Unusable row" } };
  }
  const data: Record<string, unknown> = {};
  for (const [source, raw] of Object.entries(parsed.values)) {
    const target = Object.hasOwn(mapping, source) ? mapping[source] : source;
    if (target === null) continue; // Skipped — the cell is never read.
    const field = byKey.get(target);
    if (!field) {
      return {
        rejection: {
          row: parsed.row,
          field: target,
          reason: `This entity has no field "${target}" — map the column or remove it`,
        },
      };
    }
    const value = coerceCell(raw, field);
    if (value !== undefined) data[target] = value;
  }

  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path.length ? String(issue.path[0]) : undefined;
    return {
      rejection: {
        row: parsed.row,
        ...(field ? { field } : {}),
        reason: issue?.message ?? "Invalid value",
      },
    };
  }
  return { data: result.data as Record<string, unknown> };
}

/** AC6, AC7 — within-file first (cheap), then against what is already stored. */
async function applyDedupe(
  deps: ImportDeps,
  ctx: Ctx,
  entityId: string,
  dedupeKey: string,
  candidates: Candidate[],
  rejected: RejectedRow[],
): Promise<Candidate[]> {
  const seen = new Map<unknown, number>();
  const withinFile: Candidate[] = [];
  for (const candidate of candidates) {
    const value = candidate.data[dedupeKey];
    if (value === undefined) {
      withinFile.push(candidate);
      continue;
    }
    const first = seen.get(value);
    if (first !== undefined) {
      rejected.push({
        row: candidate.row,
        field: dedupeKey,
        reason: `Duplicate of row ${first} on "${dedupeKey}"`,
      });
      continue;
    }
    seen.set(value, candidate.row);
    withinFile.push(candidate);
  }

  const values = [...seen.keys()];
  if (!values.length) return withinFile;

  // `dedupeKey` is a field key off the entity definition, so the path is
  // `/^data\.[a-z][a-z0-9_]*$/` by construction — there is no client string in
  // this filter, and the repository injects the tenant (AC11).
  const existing = await deps.records.find(ctx, {
    entityDefId: new ObjectId(entityId),
    [`data.${dedupeKey}`]: { $in: values },
  } as Filter<RecordDoc>);
  if (!existing.length) return withinFile;

  const taken = new Set(existing.map((doc) => doc.data[dedupeKey]));
  const survivors: Candidate[] = [];
  for (const candidate of withinFile) {
    if (taken.has(candidate.data[dedupeKey])) {
      rejected.push({
        row: candidate.row,
        field: dedupeKey,
        reason: `A record with this "${dedupeKey}" already exists — imports never overwrite`,
      });
      continue;
    }
    survivors.push(candidate);
  }
  return survivors;
}

/**
 * AC8 — how many of `wanted` rows may actually be written. `checkQuota`
 * reserves atomically, so a refusal has already told us the headroom; the
 * second call reserves exactly that. A downgrade freeze (`read_only`) is not a
 * partial import — there is no headroom to find, so it is a hard refusal.
 */
async function reserve(
  deps: ImportDeps,
  ctx: Ctx,
  wanted: number,
): Promise<{ allowed: number; remaining: number | null }> {
  if (wanted === 0) {
    const peek = await deps.peekQuota(ctx, "records");
    return { allowed: 0, remaining: peek.remaining };
  }
  const first = await deps.checkQuota(ctx, "records", wanted);
  if (first.allowed) return { allowed: wanted, remaining: first.remaining };
  if (first.reason === "read_only") {
    throw new AppError(
      "QUOTA_EXCEEDED",
      "Records are read-only on your current plan. Upgrade to import; nothing has been deleted.",
      { meter: "records", reason: "read_only" },
    );
  }

  const headroom = first.remaining ?? 0;
  if (headroom <= 0) return { allowed: 0, remaining: 0 };
  const second = await deps.checkQuota(ctx, "records", headroom);
  return second.allowed
    ? { allowed: headroom, remaining: second.remaining }
    : { allowed: 0, remaining: second.remaining };
}

/** AC5 — the dry run's equivalent of `reserve`, which never touches the meter. */
async function previewReserve(
  deps: ImportDeps,
  ctx: Ctx,
  wanted: number,
): Promise<{ allowed: number; remaining: number | null }> {
  const peek = await deps.peekQuota(ctx, "records");
  if (peek.remaining === null) return { allowed: wanted, remaining: null };
  const allowed = Math.min(wanted, peek.remaining);
  return { allowed, remaining: peek.remaining - allowed };
}

function toResult(doc: ImportDoc & { _id: ObjectId }): ImportResult {
  return {
    importId: doc._id.toHexString(),
    dryRun: doc.dryRun,
    format: doc.format,
    total: doc.total,
    imported: doc.imported,
    rejected: doc.rejected,
    rejectedCount: doc.rejectedCount,
    dedupe: { key: doc.dedupeKey, applied: doc.dedupeKey !== null },
    quota: { meter: "records", remaining: doc.quotaRemaining },
  };
}

/**
 * AC1–AC12. The whole import, start to finish: gate, read, parse, map,
 * validate, dedupe, reserve, write, record.
 */
export async function startImport(
  ctx: Ctx,
  entityId: string,
  input: unknown,
  overrides: Partial<ImportDeps> = {},
): Promise<ImportResult> {
  const deps = resolveDeps(overrides);
  const body = startImportSchema.parse(input);

  // AC1 — before the file is read, let alone parsed. A Free tenant's import
  // costs one entitlement lookup and nothing else.
  await assertMayImport(deps, ctx);

  // Tenant-scoped: another tenant's entity is a 404 from here (AC11).
  const entity = await deps.getEntity(ctx, entityId);
  const entitlements = await deps.entitlements(ctx);
  const dedupeKey = body.dedupeKey ?? null;
  assertMapping(body.mapping, dedupeKey, entity.fields);

  const file = await deps.readFile(ctx, body.mediaId);
  if (file.contentType !== CONTENT_TYPE_FOR_FORMAT[body.format]) {
    throw badBody({ format: `This upload is "${file.contentType}", not ${body.format}` });
  }
  const parsedRows = parseImportFile(file.text, body.format);

  // AC2 — the row ceiling is checked before a single row is written.
  const rowLimit = rowLimitFor(entitlements);
  if (rowLimit !== null && parsedRows.length > rowLimit) {
    throw new AppError(
      "ROW_LIMIT_EXCEEDED",
      `An import may contain at most ${rowLimit} rows on your plan. Split the file or upgrade.`,
      { limit: rowLimit, rows: parsedRows.length },
    );
  }

  const schema = getCompiledSchema(ctx.tenantId, entityId, entity.schemaVersion, entity.fields);
  const byKey = new Map(entity.fields.map((f) => [f.key, f]));

  const rejected: RejectedRow[] = [];
  let candidates: Candidate[] = [];
  for (const parsed of parsedRows) {
    const { data, rejection } = buildRow(parsed, body.mapping, byKey, schema);
    if (rejection) rejected.push(rejection);
    else if (data) candidates.push({ row: parsed.row, data });
  }

  if (dedupeKey !== null) {
    candidates = await applyDedupe(deps, ctx, entityId, dedupeKey, candidates, rejected);
  }

  const { allowed, remaining } = body.dryRun
    ? await previewReserve(deps, ctx, candidates.length)
    : await reserve(deps, ctx, candidates.length);

  const accepted = candidates.slice(0, allowed);
  for (const overflow of candidates.slice(allowed)) {
    rejected.push({ row: overflow.row, reason: quotaReason("records") });
  }

  if (!body.dryRun) {
    for (const candidate of accepted) {
      await deps.records.insertOne(ctx, {
        entityDefId: new ObjectId(entityId),
        schemaVersion: entity.schemaVersion,
        data: candidate.data,
        deletedAt: null,
      } as unknown as Omit<RecordDoc, "tenantId" | "createdAt" | "updatedAt">);
    }
  }

  rejected.sort((a, b) => a.row - b.row);

  const doc = await deps.repo.insertOne(ctx, {
    entityDefId: new ObjectId(entityId),
    mediaId: new ObjectId(body.mediaId),
    format: body.format,
    dryRun: body.dryRun,
    total: parsedRows.length,
    imported: accepted.length,
    rejected: rejected.slice(0, MAX_STORED_REJECTIONS),
    rejectedCount: rejected.length,
    dedupeKey,
    quotaRemaining: remaining,
    deletedAt: null,
  } as unknown as Omit<ImportDoc, "tenantId" | "createdAt" | "updatedAt">);

  // AC12 — counts, never contents. A row is the tenant's business data.
  deps.log.info("import.completed", {
    requestId: ctx.requestId,
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    entityId,
    importId: doc._id.toHexString(),
    format: body.format,
    dryRun: body.dryRun,
    total: parsedRows.length,
    imported: accepted.length,
    rejected: rejected.length,
  });

  return toResult(doc);
}

/**
 * AC9 — step one of the two-call upload (docs/BACKEND.md §4). The import file
 * goes straight to the bucket; this route hands back a signed PUT and never
 * sees a byte. Gated and entity-scoped, so a Free tenant cannot use the
 * bucket as free storage and tenant B cannot stage a file against tenant A's
 * entity (AC11).
 */
export async function requestImportUpload(
  ctx: Ctx,
  entityId: string,
  input: unknown,
  overrides: Partial<ImportDeps> = {},
): Promise<UploadTicket> {
  const deps = resolveDeps(overrides);
  await assertMayImport(deps, ctx);
  await deps.getEntity(ctx, entityId);
  // Parsed here as well as in the route: the service is the boundary that
  // matters, and this is what makes the ticket's allow-list (CSV/JSON, not
  // images) a property of the import path rather than of one caller.
  return deps.requestUpload(
    ctx,
    { type: "import", id: entityId },
    requestImportUploadSchema.parse(input),
  );
}

/** AC9 — step two: the bytes have landed, so the row becomes usable. */
export async function confirmImportUpload(
  ctx: Ctx,
  entityId: string,
  mediaId: string,
  overrides: Partial<ImportDeps> = {},
): Promise<MediaView> {
  const deps = resolveDeps(overrides);
  await assertMayImport(deps, ctx);
  await deps.getEntity(ctx, entityId);
  return deps.confirmUpload(ctx, mediaId);
}

/** AC11 — tenant- and entity-scoped; anything else is a 404, not a hint. */
export async function getImportResult(
  ctx: Ctx,
  entityId: string,
  importId: string,
  overrides: Partial<ImportDeps> = {},
): Promise<ImportResult> {
  const deps = resolveDeps(overrides);
  if (!ObjectId.isValid(importId)) throw new AppError("NOT_FOUND", "Import not found");
  const doc = await deps.repo.findOne(ctx, {
    _id: new ObjectId(importId),
    entityDefId: new ObjectId(entityId),
  } as Filter<ImportDoc>);
  if (!doc) throw new AppError("NOT_FOUND", "Import not found");
  return toResult(doc);
}
