/**
 * POST /api/v1/plugins/:pluginId/enable (GRAFT-14 AC1, AC3, AC4, AC6, AC7).
 *
 * Errors: 404 NOT_FOUND (unknown pluginId), 403 FORBIDDEN (tier too low),
 * 403 QUOTA_EXCEEDED (at the tenant's plugin limit).
 */
import { enablePlugin, pluginIdParamSchema } from "@/server/services/plugins";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseParams } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { pluginId: string };

export const POST = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  const { pluginId } = parseParams(params, pluginIdParamSchema);
  const plugin = await enablePlugin(ctx, pluginId);
  return jsonOk(plugin, requestId);
});
