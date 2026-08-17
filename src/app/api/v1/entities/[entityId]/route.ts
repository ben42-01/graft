/**
 * GET/PATCH/DELETE /api/v1/entities/:entityId (GRAFT-06).
 *
 * Tenant isolation (AC6) needs no code here: the repository layer scopes every
 * read and write by `ctx.tenantId`, so another tenant's entity is simply not
 * found — 404, not 403, so existence is not leaked.
 */
import {
  deleteEntity,
  entityIdParamSchema,
  getEntity,
  updateEntity,
  updateEntitySchema,
} from "@/server/services/entities";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseParams } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { entityId: string };

export const GET = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  const { entityId } = parseParams(params, entityIdParamSchema);
  const entity = await getEntity(ctx, entityId);
  return jsonOk(entity, requestId);
});

export const PATCH = route<Params>(async (request, { requestId, context, params }) => {
  const ctx = await context();
  const { entityId } = parseParams(params, entityIdParamSchema);
  const body = await parseBody(request, updateEntitySchema);
  const entity = await updateEntity(ctx, entityId, body);
  return jsonOk(entity, requestId);
});

export const DELETE = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  const { entityId } = parseParams(params, entityIdParamSchema);
  await deleteEntity(ctx, entityId);
  return new Response(null, { status: 204, headers: { "x-request-id": requestId } });
});
