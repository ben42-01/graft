/**
 * Dashboards — the widget registry's config schema plus dashboard CRUD
 * (GRAFT-13, docs/Graft.md §4.3, docs/BACKEND.md §1, §2, docs/TIERS.md §2.1).
 *
 * A dashboard is stored as pure JSON — `widgets[]`, each `{ id, type, config,
 * layout }` — never a component reference or a chunk of markup (AC1). That is
 * what makes AC2 possible: a widget `type` the server has never heard of is
 * still valid data. Only *known* types get their `config` checked against a
 * per-type schema here; an unknown type is stored as-is and it is the client
 * registry's job (src/lib/widgets/registry.tsx) to fall back to a placeholder
 * rather than crash (AC2 is a two-layer guarantee: never reject on write,
 * never crash on render).
 *
 * Widgets carry no data of their own and no privileged read path — the API
 * Contract is explicit that widget data comes from the existing entity/
 * record/meter endpoints. This module only persists *layout*.
 */
import { ObjectId, type Filter } from "mongodb";
import { z } from "zod";
import type { Ctx } from "@/server/context";
import { AppError } from "@/server/http/envelope";
import { clampLimit } from "@/server/http/pagination";
import { parse } from "@/server/http/validate";
import {
  METERS,
  consumeQuota as consumeQuotaDefault,
  type Meter,
  type QuotaResult,
} from "./meters";
import { createRepository, type Repository } from "@/server/repositories/base";

const objectIdHex = z.string().regex(/^[0-9a-f]{24}$/i, "Expected a 24-character id");
const meterKey = z.enum(Object.keys(METERS) as [Meter, ...Meter[]]);

/** Ends up in a Mongo record path (records, GRAFT-07) — never `$`, never `.`. */
const fieldKey = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "Use lowercase letters, digits and underscores, starting with a letter",
  );

/** The MVP widget set (docs/Graft.md §4.3). GRAFT-14's plugin-contributed path
 * extends this registry later; this issue only needs it to be extensible. */
export const KNOWN_WIDGET_TYPES = ["record_list", "kpi", "calendar", "chart"] as const;
export type KnownWidgetType = (typeof KNOWN_WIDGET_TYPES)[number];

/** Chart is the one MVP widget behind a tier gate (Constraints — docs/TIERS.md
 * §2.4 Reports). Every other known type is available on every tier. */
export const WIDGET_REQUIRED_FEATURE: Partial<Record<KnownWidgetType, "reports">> = {
  chart: "reports",
};

const WIDGET_CONFIG_SCHEMAS: Record<KnownWidgetType, z.ZodTypeAny> = {
  record_list: z
    .object({ entityId: objectIdHex, limit: z.number().int().min(1).max(50).optional() })
    .strict(),
  kpi: z
    .object({
      source: z.enum(["meter", "count"]),
      meter: meterKey.optional(),
      entityId: objectIdHex.optional(),
      label: z.string().trim().min(1).max(120),
    })
    .strict()
    .refine((v) => (v.source === "meter" ? v.meter !== undefined : v.entityId !== undefined), {
      message: "A meter-sourced KPI needs `meter`; a count-sourced KPI needs `entityId`",
    }),
  calendar: z.object({ entityId: objectIdHex, dateField: fieldKey }).strict(),
  chart: z.object({ meter: meterKey, label: z.string().trim().min(1).max(120) }).strict(),
};

const isKnownType = (type: string): type is KnownWidgetType =>
  (KNOWN_WIDGET_TYPES as readonly string[]).includes(type);

const GRID_COLUMNS = 4;

const layoutSchema = z.object({
  x: z
    .number()
    .int()
    .min(0)
    .max(GRID_COLUMNS - 1),
  y: z.number().int().min(0),
  w: z.number().int().min(1).max(GRID_COLUMNS),
  h: z.number().int().min(1).max(4),
});

/**
 * AC1, AC2 — the widget envelope is fixed and strict; `config` is a bag of
 * JSON that is only interpreted, never executed (Constraints — "never let a
 * widget config name a raw query"). A known type's config is validated
 * against its own schema so a malformed KPI/Chart/etc cannot be written; an
 * unknown type's config is only checked for being plain JSON.
 */
export const widgetSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    type: z.string().trim().min(1).max(64),
    config: z.record(z.string(), z.unknown()).default({}),
    layout: layoutSchema,
  })
  .superRefine((widget, ctx) => {
    if (!isKnownType(widget.type)) return; // AC2 — an unknown type is still valid data
    const result = WIDGET_CONFIG_SCHEMAS[widget.type].safeParse(widget.config);
    if (result.success) return;
    for (const issue of result.error.issues) {
      ctx.addIssue({ ...issue, path: ["config", ...issue.path] });
    }
  });

export type WidgetConfig = z.infer<typeof widgetSchema>;

const widgetsSchema = z.array(widgetSchema).max(40);

export const createDashboardSchema = z.object({
  name: z.string().trim().min(1).max(120),
  widgets: widgetsSchema.default([]),
});

export const updateDashboardSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    widgets: widgetsSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.widgets !== undefined, {
    message: "Nothing to update",
  });

export const listDashboardsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.union([z.string(), z.number()]).optional(),
});

export const dashboardIdParamSchema = z.object({ dashboardId: objectIdHex });

export type CreateDashboardInput = z.input<typeof createDashboardSchema>;
export type UpdateDashboardInput = z.input<typeof updateDashboardSchema>;

export type DashboardDoc = {
  tenantId: ObjectId;
  /** Provenance only (scripts/create-indexes.ts `{tenantId,ownerId}` index) —
   * every read below is tenant-scoped, not owner-scoped: a dashboard is
   * shared workspace state, the same way an entity or a form is. */
  ownerId: ObjectId;
  name: string;
  widgets: WidgetConfig[];
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DashboardView = {
  id: string;
  name: string;
  widgets: WidgetConfig[];
  createdAt: Date;
  updatedAt: Date;
};

function toView(doc: { _id: ObjectId } & DashboardDoc): DashboardView {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    widgets: doc.widgets,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export type DashboardDeps = {
  repo: Repository<DashboardDoc>;
  consumeQuota: (ctx: Ctx, meter: Meter, amount?: number) => Promise<QuotaResult>;
};

const defaultRepo = createRepository<DashboardDoc>("dashboards");

function resolveDeps(overrides: Partial<DashboardDeps> = {}): DashboardDeps {
  return {
    repo: overrides.repo ?? defaultRepo,
    consumeQuota:
      overrides.consumeQuota ??
      ((ctx, meter, amount) => consumeQuotaDefault(ctx, meter, amount)),
  };
}

/** AC6 — quota is reserved before the write, so a refusal never leaves a
 * partial dashboard behind (same ordering as entities.ts createEntity). */
export async function createDashboard(
  ctx: Ctx,
  input: unknown,
  overrides: Partial<DashboardDeps> = {},
): Promise<DashboardView> {
  const deps = resolveDeps(overrides);
  const parsed = parse(createDashboardSchema, input, "body");
  await deps.consumeQuota(ctx, "dashboards");
  const doc = await deps.repo.insertOne(ctx, {
    ownerId: new ObjectId(ctx.userId),
    name: parsed.name,
    widgets: parsed.widgets,
    deletedAt: null,
  });
  return toView(doc);
}

export async function listDashboards(
  ctx: Ctx,
  query: { cursor?: string; limit?: unknown },
  overrides: Partial<DashboardDeps> = {},
) {
  const deps = resolveDeps(overrides);
  const { items, meta } = await deps.repo.listPage(ctx, {
    cursor: query.cursor,
    limit: clampLimit(query.limit),
  });
  return { items: items.map(toView), meta };
}

/** AC7 — another tenant's dashboard is simply not found; the repository
 * layer scopes the read by ctx.tenantId, so there is nothing to check here. */
export async function getDashboard(
  ctx: Ctx,
  dashboardId: string,
  overrides: Partial<DashboardDeps> = {},
): Promise<DashboardView> {
  const deps = resolveDeps(overrides);
  const doc = await deps.repo.findById(ctx, dashboardId);
  if (!doc) throw new AppError("NOT_FOUND", "Dashboard not found");
  return toView(doc);
}

/** AC4 — the whole `widgets` array (config + layout together) is replaced in
 * one write, so an add/move/remove on the composer is a single PATCH and a
 * reload always reads back a consistent layout. */
export async function updateDashboard(
  ctx: Ctx,
  dashboardId: string,
  input: unknown,
  overrides: Partial<DashboardDeps> = {},
): Promise<DashboardView> {
  const deps = resolveDeps(overrides);
  const parsed = parse(updateDashboardSchema, input, "body");
  const updated = await deps.repo.updateOne(
    ctx,
    { _id: new ObjectId(dashboardId) } as Filter<DashboardDoc>,
    {
      $set: {
        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        ...(parsed.widgets !== undefined ? { widgets: parsed.widgets } : {}),
      },
    },
  );
  if (!updated) throw new AppError("NOT_FOUND", "Dashboard not found");
  return toView(updated);
}

export async function deleteDashboard(
  ctx: Ctx,
  dashboardId: string,
  overrides: Partial<DashboardDeps> = {},
): Promise<void> {
  const deps = resolveDeps(overrides);
  const deleted = await deps.repo.softDelete(ctx, dashboardId);
  if (!deleted) throw new AppError("NOT_FOUND", "Dashboard not found");
}
