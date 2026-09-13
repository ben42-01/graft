/**
 * POST /api/v1/entities/:entityId/import-uploads — step one of the import
 * file upload (GRAFT-25.1 AC9, docs/BACKEND.md §4).
 *
 * Returns a short-lived presigned PUT the browser uploads the CSV or JSON to
 * directly; no file bytes ever pass through this route. Step two is
 * POST .../import-uploads/:mediaId, which re-reads the object with a HEAD and
 * promotes the row to `ready` — only then can it be named by an import.
 *
 * A sibling path rather than a segment under `/imports`, so `:importId` stays
 * unambiguously an import result id.
 */
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseParams } from "@/server/http/validate";
import { importParamSchema, requestImportUpload } from "@/server/services/imports";
import { requestImportUploadSchema } from "@/server/services/media";

export const dynamic = "force-dynamic";

type Params = { entityId: string };

export const POST = route<Params>(
  async (request, { requestId, context, params }) => {
    const ctx = await context();
    const { entityId } = parseParams(params, importParamSchema);
    const input = await parseBody(request, requestImportUploadSchema);
    const ticket = await requestImportUpload(ctx, entityId, input);
    return jsonOk(ticket, requestId, undefined, { status: 201 });
  },
  { rateLimit: { scopes: ["global-ip", "api", "user"] } },
);
