/**
 * GET/PATCH/DELETE /api/v1/entities/:entityId/records/:recordId (GRAFT-07).
 *
 * Tenant isolation (AC8) needs no code here: the repository layer scopes every
 * read and write by `ctx.tenantId`, so another tenant's record — or a record
 * under an entity that isn't this tenant's — is simply not found, 404.
 */
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseJsonBody, parseParams, parseQuery } from "@/server/http/validate";
import {
  deleteRecord,
  getRecord,
  getRecordQuerySchema,
  recordParamSchema,
  updateRecord,
} from "@/server/services/records";

export const dynamic = "force-dynamic";

type Params = { entityId: string; recordId: string };

export const GET = route<Params>(async (request, { requestId, context, params }) => {
  const ctx = await context();
  const { entityId, recordId } = parseParams(params, recordParamSchema);
  const { includeDeleted } = parseQuery(request, getRecordQuerySchema);
  const record = await getRecord(ctx, entityId, recordId, {
    includeDeleted: includeDeleted !== undefined,
  });
  return jsonOk(record, requestId);
});

export const PATCH = route<Params>(async (request, { requestId, context, params }) => {
  const ctx = await context();
  const { entityId, recordId } = parseParams(params, recordParamSchema);
  const body = await parseJsonBody(request);
  const record = await updateRecord(ctx, entityId, recordId, body);
  return jsonOk(record, requestId);
});

export const DELETE = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  const { entityId, recordId } = parseParams(params, recordParamSchema);
  await deleteRecord(ctx, entityId, recordId);
  return new Response(null, { status: 204, headers: { "x-request-id": requestId } });
});
