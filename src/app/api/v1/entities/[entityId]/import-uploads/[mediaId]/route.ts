/**
 * POST /api/v1/entities/:entityId/import-uploads/:mediaId — step two of the
 * import file upload (GRAFT-25.1 AC9).
 *
 * The bytes have landed in the bucket; this re-reads the object's real length
 * with a HEAD, charges `storage_mb` and promotes the row to `ready`. An
 * unconfirmed upload can never be imported.
 */
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseParams } from "@/server/http/validate";
import { confirmImportUpload, importParamSchema } from "@/server/services/imports";
import { mediaIdParamSchema } from "@/server/services/media";

export const dynamic = "force-dynamic";

type Params = { entityId: string; mediaId: string };

const paramSchema = importParamSchema.extend(mediaIdParamSchema.shape);

export const POST = route<Params>(
  async (_request, { requestId, context, params }) => {
    const ctx = await context();
    const { entityId, mediaId } = parseParams(params, paramSchema);
    return jsonOk(await confirmImportUpload(ctx, entityId, mediaId), requestId);
  },
  { rateLimit: { scopes: ["global-ip", "api", "user"] } },
);
