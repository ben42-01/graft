/**
 * POST /api/v1/workspace-templates/:templateId/apply — set the workspace up:
 * every entity, sample record, bookable pool and form the template resolves
 * to. Send `runId` (from a failed attempt's error details) to resume that run
 * instead of starting another.
 *
 * Errors: 404 NOT_FOUND (no such template or run), 400 VALIDATION_FAILED (a
 * bad answer), 403 QUOTA_EXCEEDED (the plan has too little left — refused
 * before anything is created), 409 CONFLICT (no free name left to use).
 */
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseParams } from "@/server/http/validate";
import {
  applyBodySchema,
  applyWorkspaceTemplate,
  templateIdParamSchema,
} from "@/server/services/workspace-templates";

export const dynamic = "force-dynamic";

type Params = { templateId: string };

export const POST = route<Params>(
  async (request, { requestId, context, params }) => {
    const ctx = await context();
    const { templateId } = parseParams(params, templateIdParamSchema);
    const body = await parseBody(request, applyBodySchema);
    const result = await applyWorkspaceTemplate(ctx, templateId, body);
    return jsonOk(result, requestId, undefined, { status: 201 });
  },
  // Declared rather than inherited: one call here is a dozen writes, charged
  // to the tenant and to the user who ran it (docs/BACKEND.md §4).
  { rateLimit: { scopes: ["global-ip", "api", "user"] } },
);
