/**
 * GET /api/v1/entities/:entityId/imports/:importId — re-read one import result
 * (GRAFT-25.1).
 *
 * The same body the POST returned, so the wizard (GRAFT-25.2) can reopen a
 * preview or a finished run without holding it in the browser. Tenant- and
 * entity-scoped through the repository layer: another tenant's import id is a
 * 404 that says nothing about whether it exists (AC11).
 */
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseParams } from "@/server/http/validate";
import { getImportResult, importResultParamSchema } from "@/server/services/imports";

export const dynamic = "force-dynamic";

type Params = { entityId: string; importId: string };

export const GET = route<Params>(
  async (_request, { requestId, context, params }) => {
    const ctx = await context();
    const { entityId, importId } = parseParams(params, importResultParamSchema);
    return jsonOk(await getImportResult(ctx, entityId, importId), requestId);
  },
  { rateLimit: { scopes: ["global-ip", "api", "user"] } },
);
