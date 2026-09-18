/**
 * GET /api/v1/workspace-templates/:templateId — one template's full
 * blueprint: its toggles, modules, renameable nouns and optional fields,
 * which is everything the setup wizard asks about.
 *
 * Errors: 404 NOT_FOUND (no such template).
 */
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseParams } from "@/server/http/validate";
import {
  getWorkspaceTemplate,
  templateIdParamSchema,
} from "@/server/services/workspace-templates";

export const dynamic = "force-dynamic";

type Params = { templateId: string };

export const GET = route<Params>(async (_request, { requestId, context, params }) => {
  await context();
  const { templateId } = parseParams(params, templateIdParamSchema);
  return jsonOk(getWorkspaceTemplate(templateId), requestId);
});
