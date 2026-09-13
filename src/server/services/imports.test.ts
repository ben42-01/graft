/**
 * Batch record import — unit coverage (GRAFT-25.1).
 *
 * Everything here runs against fakes: an in-memory records repository, a fake
 * import-result repository, a stubbed file reader and a stubbed meter. That is
 * deliberate — the rejection-reason table, the dedupe rules and the
 * `null`-is-unlimited branch are pure decisions, and a decision that needs a
 * database to be proven is a decision that is hard to trust.
 */
import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { createContext, type Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import type { Repository } from "@/server/repositories/base";
import { TIER_FEATURES, TIER_LIMITS } from "@/server/tiers";
import type { EntityView, FieldDef } from "./entities";
import {
  MAX_STORED_REJECTIONS,
  ROWS_PER_IMPORT,
  confirmImportUpload,
  getImportResult,
  parseCsvRows,
  parseImportFile,
  requestImportUpload,
  rowLimitFor,
  startImport,
  type ImportDeps,
  type ImportDoc,
} from "./imports";
import type { Entitlements } from "./entitlements";
import type { QuotaResult } from "./meters";
import type { RecordDoc } from "./records";

const TENANT = "000000000000000000000001";
const ENTITY = "000000000000000000000021";
const MEDIA = "0000000000000000000000a1";

const ctx: Ctx = createContext({
  requestId: "req-import",
  tenantId: TENANT,
  userId: "00000000000000000000000b",
  roles: ["owner"],
  tier: "premium",
});

const FIELDS: FieldDef[] = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "sku", label: "SKU", type: "text", required: false },
  { key: "price", label: "Price", type: "number", required: false },
  { key: "active", label: "Active", type: "checkbox", required: false },
];

const entity: EntityView = {
  id: ENTITY,
  key: "products",
  name: "Products",
  fields: FIELDS,
  schemaVersion: 3,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const entitlementsFor = (
  tier: "free" | "premium" | "enterprise",
  over: Partial<Entitlements> = {},
): Entitlements =>
  Object.freeze({
    tenantId: TENANT,
    tier,
    limits: { ...TIER_LIMITS[tier] },
    features: { ...TIER_FEATURES[tier] },
    readOnly: [],
    downgradedAt: null,
    billingAnchorDay: 1,
    ...over,
  }) as Entitlements;

/** A records repository that only does what the import service asks of it. */
function fakeRecordsRepo(seed: RecordDoc[] = []) {
  const docs = seed.map((d) => ({ ...d, _id: new ObjectId() }));
  return {
    docs,
    repo: {
      collectionName: "records",
      async find(_ctx: Ctx, filter: Record<string, unknown>) {
        const entries = Object.entries(filter).filter(([k]) => k.startsWith("data."));
        return docs.filter((doc) =>
          entries.every(([path, clause]) => {
            const key = path.slice("data.".length);
            const wanted = (clause as { $in?: unknown[] }).$in;
            return Array.isArray(wanted) && wanted.includes(doc.data[key]);
          }),
        );
      },
      async insertOne(_ctx: Ctx, row: { data: Record<string, unknown> }) {
        const stored = {
          ...(row as unknown as RecordDoc),
          _id: new ObjectId(),
          createdAt: new Date(),
          updatedAt: new Date(),
        } as RecordDoc & { _id: ObjectId };
        docs.push(stored);
        return stored;
      },
    } as unknown as Repository<RecordDoc>,
  };
}

function fakeImportRepo() {
  const saved: (ImportDoc & { _id: ObjectId })[] = [];
  return {
    saved,
    repo: {
      collectionName: "imports",
      async insertOne(_ctx: Ctx, doc: ImportDoc) {
        const stored = { ...doc, _id: new ObjectId() } as ImportDoc & { _id: ObjectId };
        saved.push(stored);
        return stored;
      },
      async findOne(_ctx: Ctx, filter: { _id?: ObjectId; entityDefId?: ObjectId }) {
        return (
          saved.find(
            (d) =>
              d._id.equals(filter._id as ObjectId) &&
              (!filter.entityDefId || d.entityDefId.equals(filter.entityDefId)),
          ) ?? null
        );
      },
    } as unknown as Repository<ImportDoc>,
  };
}

const quota = (over: Partial<QuotaResult> = {}): QuotaResult =>
  ({
    meter: "records",
    period: "all",
    allowed: true,
    limit: 100_000,
    used: 0,
    remaining: 100_000,
    warned: false,
    ...over,
  }) as QuotaResult;

type Harness = {
  deps: Partial<ImportDeps>;
  records: ReturnType<typeof fakeRecordsRepo>;
  imports: ReturnType<typeof fakeImportRepo>;
  checkQuota: ReturnType<typeof vi.fn>;
};

function harness(
  text: string,
  over: {
    tier?: "free" | "premium" | "enterprise";
    entitlements?: Entitlements;
    seed?: RecordDoc[];
    quotas?: QuotaResult[];
    peek?: QuotaResult;
    contentType?: string;
  } = {},
): Harness {
  const records = fakeRecordsRepo(over.seed);
  const imports = fakeImportRepo();
  const queue = [...(over.quotas ?? [])];
  const checkQuota = vi.fn(async () => queue.shift() ?? quota());
  const ent = over.entitlements ?? entitlementsFor(over.tier ?? "premium");
  return {
    records,
    imports,
    checkQuota,
    deps: {
      repo: imports.repo,
      records: records.repo,
      getEntity: async () => entity,
      entitlements: async () => ent,
      can: async () => ent.features.csv_import === true,
      readFile: async () => ({ text, contentType: over.contentType ?? "text/csv" }),
      checkQuota: checkQuota as unknown as ImportDeps["checkQuota"],
      peekQuota: async () => over.peek ?? quota(),
    },
  };
}

const body = (over: Record<string, unknown> = {}) => ({
  mediaId: MEDIA,
  format: "csv" as const,
  mapping: {},
  dryRun: false,
  ...over,
});

const csv = (rows: string[][]) => rows.map((r) => r.join(",")).join("\n");

describe("parseCsvRows", () => {
  it("handles quoted cells, embedded commas, escaped quotes and CRLF", () => {
    const rows = parseCsvRows('name,note\r\n"King, Ada","said ""hi"""\r\nplain,x\r\n');
    expect(rows).toEqual([
      ["name", "note"],
      ["King, Ada", 'said "hi"'],
      ["plain", "x"],
    ]);
  });

  it("refuses a file whose quoting never closes", () => {
    expect(() => parseCsvRows('name\n"never ends')).toThrow(AppError);
  });
});

describe("parseImportFile", () => {
  it("keys CSV rows by their header and numbers data rows from one", () => {
    const parsed = parseImportFile("name,sku\nAda,A-1\nGrace,G-2\n", "csv");
    expect(parsed).toEqual([
      { row: 1, values: { name: "Ada", sku: "A-1" } },
      { row: 2, values: { name: "Grace", sku: "G-2" } },
    ]);
  });

  it("marks a ragged CSV row rather than shifting its values", () => {
    const parsed = parseImportFile("name,sku\nAda,A-1,extra\n", "csv");
    expect(parsed[0]?.values).toBeUndefined();
    expect(parsed[0]?.error).toMatch(/2 columns/);
  });

  it("AC10 — an unparseable file is refused, naming the format", () => {
    expect(() => parseImportFile("{ not json", "json")).toThrow(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        details: { source: "body", fields: { "(file)": expect.stringContaining("json") } },
      }),
    );
    expect(() => parseImportFile("", "csv")).toThrow(
      expect.objectContaining({
        details: { source: "body", fields: { "(file)": expect.stringContaining("csv") } },
      }),
    );
  });

  it("AC10 — JSON must be an array of objects; a non-object element is a row error", () => {
    const parsed = parseImportFile('[{"name":"Ada"}, 7]', "json");
    expect(parsed[0]?.values).toEqual({ name: "Ada" });
    expect(parsed[1]?.error).toMatch(/object/i);
  });
});

describe("rowLimitFor", () => {
  it("AC2 — Premium is capped per import", () => {
    expect(rowLimitFor(entitlementsFor("premium"))).toBe(ROWS_PER_IMPORT);
  });

  it("AC2 — a null records limit is unlimited, not zero", () => {
    expect(TIER_LIMITS.enterprise.records).toBeNull();
    expect(rowLimitFor(entitlementsFor("enterprise"))).toBeNull();
  });
});

describe("startImport — gating", () => {
  it("AC1 — Free is refused with FEATURE_NOT_AVAILABLE naming csv_import, before parsing", async () => {
    const h = harness(csv([["name"], ["Ada"]]), { tier: "free" });
    const readFile = vi.fn(h.deps.readFile!);
    await expect(
      startImport(ctx, ENTITY, body(), { ...h.deps, readFile }),
    ).rejects.toMatchObject({
      code: "FEATURE_NOT_AVAILABLE",
      status: 403,
      details: { feature: "csv_import" },
    });
    expect(readFile).not.toHaveBeenCalled();
    expect(h.records.docs).toHaveLength(0);
    expect(h.checkQuota).not.toHaveBeenCalled();
  });

  it("AC2 — Premium refuses 10,001 rows with ROW_LIMIT_EXCEEDED and writes nothing", async () => {
    const rows = [["name"], ...Array.from({ length: 10_001 }, (_, i) => [`Row ${i}`])];
    const h = harness(csv(rows));
    await expect(startImport(ctx, ENTITY, body(), h.deps)).rejects.toMatchObject({
      code: "ROW_LIMIT_EXCEEDED",
      status: 400,
      details: { limit: ROWS_PER_IMPORT, rows: 10_001 },
    });
    expect(h.records.docs).toHaveLength(0);
  });

  it("AC2 — exactly 10,000 rows is accepted at the boundary", async () => {
    const rows = [["name"], ...Array.from({ length: 10_000 }, (_, i) => [`Row ${i}`])];
    const h = harness(csv(rows));
    const result = await startImport(ctx, ENTITY, body(), h.deps);
    expect(result.total).toBe(10_000);
    expect(result.imported).toBe(10_000);
  });

  it("AC2 — Enterprise accepts more than 10,000 because null means unlimited", async () => {
    const rows = [["name"], ...Array.from({ length: 10_001 }, (_, i) => [`Row ${i}`])];
    const h = harness(csv(rows), {
      tier: "enterprise",
      quotas: [quota({ limit: null, remaining: null })],
    });
    const result = await startImport(ctx, ENTITY, body(), h.deps);
    expect(result.imported).toBe(10_001);
    expect(result.quota.remaining).toBeNull();
  });
});

describe("startImport — mapping and validation", () => {
  it("AC3 — a mapping target that is not a field on the entity is a 400", async () => {
    const h = harness(csv([["Product Name"], ["Ada"]]));
    await expect(
      startImport(ctx, ENTITY, body({ mapping: { "Product Name": "is_admin" } }), h.deps),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fields: { "mapping.Product Name": expect.stringContaining("is_admin") } },
    });
    expect(h.records.docs).toHaveLength(0);
  });

  it("AC3 — target field names come from entity_defs, so a crafted header cannot reach Mongo", async () => {
    const h = harness(
      csv([
        ["name", "isAdmin"],
        ["Ada", "true"],
      ]),
    );
    const result = await startImport(ctx, ENTITY, body(), h.deps);
    expect(result.imported).toBe(0);
    expect(result.rejected[0]).toMatchObject({ row: 1, field: "isAdmin" });
    expect(result.rejected[0]?.reason).toContain("isAdmin");
    expect(h.records.docs).toHaveLength(0);
  });

  it("AC3 — the mapping renames the column, and only the mapped target is stored", async () => {
    const h = harness(
      csv([
        ["Product Name", "Price"],
        ["Widget", "19.99"],
      ]),
    );
    const result = await startImport(
      ctx,
      ENTITY,
      body({ mapping: { "Product Name": "name", Price: "price" } }),
      h.deps,
    );
    expect(result.imported).toBe(1);
    expect(h.records.docs[0]?.data).toEqual({ name: "Widget", price: 19.99 });
  });

  it("AC3 — a required field missing is a row rejection naming the field", async () => {
    const h = harness(
      csv([
        ["name", "sku"],
        ["", "A-1"],
      ]),
    );
    const result = await startImport(ctx, ENTITY, body(), h.deps);
    expect(result.imported).toBe(0);
    expect(result.rejected).toEqual([{ row: 1, field: "name", reason: expect.any(String) }]);
  });

  it("AC4 — two bad rows in a hundred reject two rows, not the file", async () => {
    const rows: string[][] = [["name", "price"]];
    for (let i = 1; i <= 100; i += 1) {
      rows.push([`Row ${i}`, i === 7 || i === 42 ? "not-a-number" : String(i)]);
    }
    const h = harness(csv(rows));
    const result = await startImport(ctx, ENTITY, body(), h.deps);
    expect(result.total).toBe(100);
    expect(result.imported).toBe(98);
    expect(result.rejected.map((r) => r.row)).toEqual([7, 42]);
    expect(result.rejected.every((r) => r.field === "price")).toBe(true);
    expect(result.rejected.every((r) => typeof r.reason === "string" && r.reason)).toBe(true);
    expect(h.records.docs).toHaveLength(98);
  });

  it("F2 — a header named 'toString' is a row rejection naming the string field, not an inherited function", async () => {
    const h = harness(
      csv([
        ["name", "toString"],
        ["Ada", "x"],
      ]),
    );
    const result = await startImport(ctx, ENTITY, body(), h.deps);
    expect(result.imported).toBe(0);
    expect(result.rejected[0]).toMatchObject({ row: 1, field: "toString" });
    // The reason must survive JSON — an inherited function would vanish here.
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({
      rejected: [{ row: 1, field: "toString" }],
    });
    expect(h.records.docs).toHaveLength(0);
  });

  it("F4 — a stored content type that disagrees with the declared format is refused", async () => {
    const h = harness(csv([["name"], ["Ada"]]), { contentType: "application/json" });
    await expect(
      startImport(ctx, ENTITY, body({ format: "csv" }), h.deps),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fields: { format: expect.stringContaining("application/json") } },
    });
    expect(h.records.docs).toHaveLength(0);
  });

  it("coerces CSV text into the field's own type, and leaves blanks absent", async () => {
    const h = harness(
      csv([
        ["name", "price", "active", "sku"],
        ["Ada", "19.99", "true", ""],
      ]),
    );
    await startImport(ctx, ENTITY, body(), h.deps);
    expect(h.records.docs[0]?.data).toEqual({ name: "Ada", price: 19.99, active: true });
  });
});

describe("startImport — both formats, one code path (AC10)", () => {
  const twenty = Array.from({ length: 20 }, (_, i) => ({
    name: `Item ${i + 1}`,
    sku: `S-${i + 1}`,
    price: i + 1,
  }));

  it("produces identical results for the same 20 records in CSV and in JSON", async () => {
    const csvText = csv([
      ["name", "sku", "price"],
      ...twenty.map((r) => [r.name, r.sku, String(r.price)]),
    ]);
    const csvRun = harness(csvText);
    const jsonRun = harness(JSON.stringify(twenty), { contentType: "application/json" });

    const fromCsv = await startImport(ctx, ENTITY, body(), csvRun.deps);
    const fromJson = await startImport(ctx, ENTITY, body({ format: "json" }), jsonRun.deps);

    // Everything but the two things that *must* differ: the result's own id,
    // and the format it was read from. AC10 is about the outcome being the same.
    const comparable = ({
      importId: _id,
      format: _format,
      ...rest
    }: Awaited<ReturnType<typeof startImport>>) => rest;
    expect(comparable(fromCsv)).toEqual(comparable(fromJson));
    expect(fromCsv.imported).toBe(20);
    expect(csvRun.records.docs.map((d) => d.data)).toEqual(
      jsonRun.records.docs.map((d) => d.data),
    );
  });

  it("reports identical rejections for the same bad row in either format", async () => {
    const bad = [{ name: "Ada", price: "nope" }];
    const csvRun = harness(
      csv([
        ["name", "price"],
        ["Ada", "nope"],
      ]),
    );
    const jsonRun = harness(JSON.stringify(bad));
    const fromCsv = await startImport(ctx, ENTITY, body(), csvRun.deps);
    const fromJson = await startImport(ctx, ENTITY, body({ format: "json" }), jsonRun.deps);
    expect(fromCsv.rejected).toEqual(fromJson.rejected);
  });
});

describe("startImport — dedupe", () => {
  it("AC6 — two rows duplicated under the dedupe key: one imported, one reported", async () => {
    const h = harness(
      csv([
        ["name", "sku"],
        ["Ada", "A-1"],
        ["Grace", "G-2"],
        ["Ada again", "A-1"],
      ]),
    );
    const result = await startImport(ctx, ENTITY, body({ dedupeKey: "sku" }), h.deps);
    expect(result.imported).toBe(2);
    expect(result.dedupe).toEqual({ key: "sku", applied: true });
    expect(result.rejected).toEqual([
      { row: 3, field: "sku", reason: expect.stringContaining("row 1") },
    ]);
  });

  it("AC6 — no dedupe key means no dedupe, and the result says so", async () => {
    const h = harness(
      csv([
        ["name", "sku"],
        ["Ada", "A-1"],
        ["Ada", "A-1"],
      ]),
    );
    const result = await startImport(ctx, ENTITY, body(), h.deps);
    expect(result.imported).toBe(2);
    expect(result.dedupe).toEqual({ key: null, applied: false });
  });

  it("AC6 — a dedupe key that is not a field on the entity is a 400", async () => {
    const h = harness(csv([["name"], ["Ada"]]));
    await expect(
      startImport(ctx, ENTITY, body({ dedupeKey: "nope" }), h.deps),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("AC7 — a row duplicating a stored record is rejected and nothing is updated", async () => {
    const stored = {
      entityDefId: new ObjectId(ENTITY),
      schemaVersion: 3,
      data: { name: "Original", sku: "A-1" },
      deletedAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    } as unknown as RecordDoc;
    const h = harness(
      csv([
        ["name", "sku"],
        ["Replacement", "A-1"],
        ["Fresh", "B-2"],
      ]),
      {
        seed: [stored],
      },
    );
    const before = h.records.docs[0]?.updatedAt;

    const result = await startImport(ctx, ENTITY, body({ dedupeKey: "sku" }), h.deps);

    expect(result.imported).toBe(1);
    expect(result.rejected).toEqual([
      { row: 1, field: "sku", reason: expect.stringContaining("already exists") },
    ]);
    expect(h.records.docs[0]?.data).toEqual({ name: "Original", sku: "A-1" });
    expect(h.records.docs[0]?.updatedAt).toEqual(before);
  });
});

describe("startImport — quota (AC8)", () => {
  it("applies what fits and rejects the rest, naming the records meter", async () => {
    const rows: string[][] = [["name"]];
    for (let i = 1; i <= 100; i += 1) rows.push([`Row ${i}`]);
    const h = harness(csv(rows), {
      quotas: [
        quota({ allowed: false, reason: "quota_exceeded", used: 99_950, remaining: 50 }),
        quota({ allowed: true, used: 100_000, remaining: 0 }),
      ],
    });

    const result = await startImport(ctx, ENTITY, body(), h.deps);

    expect(result.imported).toBe(50);
    expect(result.rejected).toHaveLength(50);
    expect(result.rejected[0]?.reason).toContain("records");
    expect(result.rejected.map((r) => r.row)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 51),
    );
    expect(h.records.docs).toHaveLength(50);
    // The meter is charged for exactly what was written, never for the file.
    expect(h.checkQuota.mock.calls.map((c) => c[2])).toEqual([100, 50]);
  });

  it("rejects every row when nothing is left, and writes nothing", async () => {
    const h = harness(csv([["name"], ["Ada"], ["Grace"]]), {
      quotas: [
        quota({ allowed: false, reason: "quota_exceeded", used: 100_000, remaining: 0 }),
      ],
    });
    const result = await startImport(ctx, ENTITY, body(), h.deps);
    expect(result.imported).toBe(0);
    expect(result.rejected).toHaveLength(2);
    expect(h.records.docs).toHaveLength(0);
    expect(h.checkQuota).toHaveBeenCalledTimes(1);
  });

  it("a downgrade freeze is a hard refusal, not a partial import", async () => {
    const h = harness(csv([["name"], ["Ada"]]), {
      quotas: [quota({ allowed: false, reason: "read_only", limit: 2_000, remaining: 0 })],
    });
    await expect(startImport(ctx, ENTITY, body(), h.deps)).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });
    expect(h.records.docs).toHaveLength(0);
  });
});

describe("startImport — stored rejection cap (F5)", () => {
  it("caps the stored rejections but keeps the true count, so the response says the list was truncated rather than dropping rows silently", async () => {
    const rows: string[][] = [["name"]];
    for (let i = 1; i <= 600; i += 1) rows.push([""]); // every row is missing the required name
    const h = harness(csv(rows));

    const result = await startImport(ctx, ENTITY, body(), h.deps);

    expect(result.imported).toBe(0);
    expect(result.rejectedCount).toBe(600);
    expect(result.rejected).toHaveLength(MAX_STORED_REJECTIONS);
    // The count survives the cap, so a caller can always tell the list was
    // truncated rather than mistake it for the whole picture.
    expect(result.rejected.length).toBeLessThan(result.rejectedCount);
    expect(h.imports.saved[0]?.rejected).toHaveLength(MAX_STORED_REJECTIONS);
    expect(h.imports.saved[0]?.rejectedCount).toBe(600);
  });
});

describe("startImport — dry run (AC5)", () => {
  it("reports the same rows and touches neither the records nor the meter", async () => {
    const rows = csv([
      ["name", "price"],
      ["Ada", "1"],
      ["Bad", "nope"],
      ["Grace", "3"],
    ]);
    const wet = harness(rows);
    const dry = harness(rows, { peek: quota({ used: 10, remaining: 99_990 }) });

    const real = await startImport(ctx, ENTITY, body(), wet.deps);
    const preview = await startImport(ctx, ENTITY, body({ dryRun: true }), dry.deps);

    expect(preview.dryRun).toBe(true);
    expect(preview.total).toBe(real.total);
    expect(preview.imported).toBe(real.imported);
    expect(preview.rejected).toEqual(real.rejected);
    expect(dry.records.docs).toHaveLength(0);
    expect(dry.checkQuota).not.toHaveBeenCalled();
  });

  it("previews the quota cut-off without spending it", async () => {
    const rows: string[][] = [["name"]];
    for (let i = 1; i <= 10; i += 1) rows.push([`Row ${i}`]);
    const h = harness(csv(rows), { peek: quota({ used: 99_996, remaining: 4 }) });
    const result = await startImport(ctx, ENTITY, body({ dryRun: true }), h.deps);
    expect(result.imported).toBe(4);
    expect(result.rejected).toHaveLength(6);
    expect(h.checkQuota).not.toHaveBeenCalled();
  });
});

describe("getImportResult", () => {
  it("re-reads a stored result by id", async () => {
    const h = harness(csv([["name"], ["Ada"]]));
    const written = await startImport(ctx, ENTITY, body(), h.deps);
    const read = await getImportResult(ctx, ENTITY, written.importId, h.deps);
    expect(read).toEqual(written);
  });

  it("AC11 — an id from another tenant is a 404, not another tenant's data", async () => {
    const h = harness(csv([["name"], ["Ada"]]));
    await expect(
      getImportResult(ctx, ENTITY, new ObjectId().toHexString(), h.deps),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("AC11 — an import filed under a different entity is not readable here", async () => {
    const h = harness(csv([["name"], ["Ada"]]));
    const written = await startImport(ctx, ENTITY, body(), h.deps);
    await expect(
      getImportResult(ctx, "000000000000000000000099", written.importId, h.deps),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("startImport — logging (AC12)", () => {
  it("never puts a row's contents in the log", async () => {
    const lines: unknown[] = [];
    const h = harness(csv([["name"], ["Ada Lovelace"]]));
    await startImport(ctx, ENTITY, body(), {
      ...h.deps,
      log: { info: (msg: string, fields?: unknown) => lines.push({ msg, fields }) },
    } as Partial<ImportDeps>);
    const dumped = JSON.stringify(lines);
    expect(dumped).not.toContain("Ada Lovelace");
    expect(dumped).toContain(TENANT);
  });
});

describe("the two-call upload (AC9)", () => {
  const confirmed = {
    id: MEDIA,
    contentType: "text/csv",
    sizeBytes: 64,
    status: "ready" as const,
    url: `/api/v1/media/${MEDIA}`,
  };

  const ticket = {
    mediaId: MEDIA,
    uploadUrl: "https://bucket.test/signed",
    contentType: "text/csv" as const,
    expiresInSeconds: 900,
  };

  it("hands back a presigned ticket owned by the entity, never the file itself", async () => {
    const h = harness("");
    const requestUpload = vi.fn(async () => ticket);
    const result = await requestImportUpload(
      ctx,
      ENTITY,
      { contentType: "text/csv", sizeBytes: 1024 },
      { ...h.deps, requestUpload } as Partial<ImportDeps>,
    );
    expect(result).toEqual(ticket);
    expect(requestUpload).toHaveBeenCalledWith(
      ctx,
      { type: "import", id: ENTITY },
      { contentType: "text/csv", sizeBytes: 1024 },
    );
  });

  it("refuses a content type that is not CSV or JSON, before any URL is signed", async () => {
    const h = harness("");
    const requestUpload = vi.fn(async () => ticket);
    await expect(
      requestImportUpload(
        ctx,
        ENTITY,
        { contentType: "application/vnd.ms-excel", sizeBytes: 1024 },
        { ...h.deps, requestUpload } as Partial<ImportDeps>,
      ),
    ).rejects.toThrow();
    expect(requestUpload).not.toHaveBeenCalled();
  });

  it("AC1 — a Free tenant is refused a ticket, so it cannot stage a file at all", async () => {
    const h = harness("", { tier: "free" });
    const requestUpload = vi.fn(async () => ticket);
    await expect(
      requestImportUpload(ctx, ENTITY, { contentType: "text/csv", sizeBytes: 1024 }, {
        ...h.deps,
        requestUpload,
      } as Partial<ImportDeps>),
    ).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", status: 403 });
    expect(requestUpload).not.toHaveBeenCalled();
  });

  it("confirms the upload through the entity, which is what scopes it to the tenant", async () => {
    const h = harness("");
    const getEntity = vi.fn(async () => entity);
    const confirmUpload = vi.fn(async () => confirmed);
    const view = await confirmImportUpload(ctx, ENTITY, MEDIA, {
      ...h.deps,
      getEntity,
      confirmUpload,
    } as Partial<ImportDeps>);
    expect(view).toEqual(confirmed);
    expect(getEntity).toHaveBeenCalledWith(ctx, ENTITY);
    expect(confirmUpload).toHaveBeenCalledWith(ctx, MEDIA);
  });

  it("AC1 — a Free tenant cannot confirm one either", async () => {
    const h = harness("", { tier: "free" });
    const confirmUpload = vi.fn(async () => confirmed);
    await expect(
      confirmImportUpload(ctx, ENTITY, MEDIA, {
        ...h.deps,
        confirmUpload,
      } as Partial<ImportDeps>),
    ).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
    expect(confirmUpload).not.toHaveBeenCalled();
  });
});
