/**
 * GET /api/v1/plugins — the plugin catalogue, per-tenant (GRAFT-14 AC1, AC4).
 *
 * Thin by contract (docs/BACKEND.md §1): every decision lives in
 * src/server/services/plugins.ts and src/server/plugins.ts.
 */
import { listPlugins } from "@/server/services/plugins";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";

export const dynamic = "force-dynamic";

export const GET = route(async (_request, { requestId, context }) => {
  const ctx = await context();
  const plugins = await listPlugins(ctx);
  return jsonOk(plugins, requestId);
});
