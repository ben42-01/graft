/**
 * POST /api/v1/plugins/:pluginId/disable (GRAFT-14 AC2, AC6).
 *
 * Errors: 404 NOT_FOUND (unknown pluginId). Idempotent — disabling a plugin
 * that was never enabled, or is already disabled, is a no-op 200.
 */
import { disablePlugin, pluginIdParamSchema } from "@/server/services/plugins";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseParams } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { pluginId: string };

export const POST = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  const { pluginId } = parseParams(params, pluginIdParamSchema);
  const plugin = await disablePlugin(ctx, pluginId);
  return jsonOk(plugin, requestId);
});
