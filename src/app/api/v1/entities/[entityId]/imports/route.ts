/**
 * POST /api/v1/entities/:entityId/imports — start a batch record import
 * (GRAFT-25.1, docs/TIERS.md §2.3).
 *
 * The body names an already-uploaded file by id; the bytes went straight to
 * the bucket via the two-call presigned pattern (docs/BACKEND.md §4), so the
 * 1 MB JSON ceiling on this route stays a real ceiling and an attempt to post
 * a file through it is refused `413 PAYLOAD_TOO_LARGE` before the handler runs
 * (AC9).
 *
 * Errors: 403 FEATURE_NOT_AVAILABLE (`csv_import` is not on the plan, AC1),
 * 400 VALIDATION_FAILED (bad mapping, unparseable file, AC3/AC10),
 * 400 ROW_LIMIT_EXCEEDED (over the per-import ceiling, AC2),
 * 403 QUOTA_EXCEEDED (records frozen by a downgrade), 404 NOT_FOUND (another
 * tenant's entity or upload, AC11).
 */
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseJsonBody, parseParams } from "@/server/http/validate";
import { importParamSchema, startImport } from "@/server/services/imports";

export const dynamic = "force-dynamic";

type Params = { entityId: string };

export const POST = route<Params>(
  async (request, { requestId, context, params }) => {
    const ctx = await context();
    const { entityId } = parseParams(params, importParamSchema);
    const body = await parseJsonBody(request);
    const result = await startImport(ctx, entityId, body);
    return jsonOk(result, requestId, undefined, { status: 201 });
  },
  // AC12 — declared rather than inherited: an import is an authenticated write,
  // charged to the tenant (docs/BACKEND.md §4) and to the user who ran it.
  { rateLimit: { scopes: ["global-ip", "api", "user"] } },
);
