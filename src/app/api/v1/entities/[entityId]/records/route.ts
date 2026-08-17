/**
 * POST/GET /api/v1/entities/:entityId/records — record CRUD, list side
 * (GRAFT-07).
 *
 * The create body has no static schema: it is validated in the service against
 * a schema compiled per-entity, so the route hands the raw parsed JSON through
 * rather than pre-validating with a fixed Zod shape.
 */
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseJsonBody, parseParams, parseQuery } from "@/server/http/validate";
import {
  createRecord,
  listRecords,
  listRecordsParamSchema,
  listRecordsQuerySchema,
} from "@/server/services/records";

export const dynamic = "force-dynamic";

type Params = { entityId: string };

export const POST = route<Params>(async (request, { requestId, context, params }) => {
  const ctx = await context();
  const { entityId } = parseParams(params, listRecordsParamSchema);
  const body = await parseJsonBody(request);
  const record = await createRecord(ctx, entityId, body);
  return jsonOk(record, requestId, undefined, { status: 201 });
});

export const GET = route<Params>(async (request, { requestId, context, params }) => {
  const ctx = await context();
  const { entityId } = parseParams(params, listRecordsParamSchema);
  const query = parseQuery(request, listRecordsQuerySchema);
  const { items, meta } = await listRecords(ctx, entityId, query);
  return jsonOk(items, requestId, meta);
});
