/**
 * GET/PATCH/DELETE /api/v1/dashboards/:dashboardId (GRAFT-13).
 *
 * Tenant isolation (AC7) needs no code here: the repository layer scopes
 * every read and write by ctx.tenantId, so another tenant's dashboard is
 * simply not found — 404, not 403, so existence is not leaked.
 */
import {
  dashboardIdParamSchema,
  deleteDashboard,
  getDashboard,
  updateDashboard,
  updateDashboardSchema,
} from "@/server/services/dashboards";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseParams } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { dashboardId: string };

export const GET = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  const { dashboardId } = parseParams(params, dashboardIdParamSchema);
  const dashboard = await getDashboard(ctx, dashboardId);
  return jsonOk(dashboard, requestId);
});

export const PATCH = route<Params>(async (request, { requestId, context, params }) => {
  const ctx = await context();
  const { dashboardId } = parseParams(params, dashboardIdParamSchema);
  const body = await parseBody(request, updateDashboardSchema);
  const dashboard = await updateDashboard(ctx, dashboardId, body);
  return jsonOk(dashboard, requestId);
});

export const DELETE = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  const { dashboardId } = parseParams(params, dashboardIdParamSchema);
  await deleteDashboard(ctx, dashboardId);
  return new Response(null, { status: 204, headers: { "x-request-id": requestId } });
});
