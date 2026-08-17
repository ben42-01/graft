/**
 * GET|POST /api/v1/dashboards (GRAFT-13). Thin by contract (docs/BACKEND.md
 * §1) — all quota and validation decisions live in
 * src/server/services/dashboards.ts.
 */
import {
  createDashboard,
  createDashboardSchema,
  listDashboards,
  listDashboardsQuerySchema,
} from "@/server/services/dashboards";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseQuery } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const POST = route(async (request, { requestId, context }) => {
  const ctx = await context();
  const body = await parseBody(request, createDashboardSchema);
  const dashboard = await createDashboard(ctx, body);
  return jsonOk(dashboard, requestId, undefined, { status: 201 });
});

export const GET = route(async (request, { requestId, context }) => {
  const ctx = await context();
  const query = parseQuery(request, listDashboardsQuerySchema);
  const { items, meta } = await listDashboards(ctx, query);
  return jsonOk(items, requestId, meta);
});
