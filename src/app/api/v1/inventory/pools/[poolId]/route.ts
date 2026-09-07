/**
 * GET/PATCH/DELETE /api/v1/inventory/pools/:poolId.
 *
 * `strategy` is deliberately not patchable — see updatePool in
 * src/server/services/inventory.ts for why reinterpreting existing
 * allocations is not something a PATCH may do quietly.
 *
 * Tenant isolation needs no code here: the repository scopes every read and
 * write by ctx.tenantId, so another tenant's pool is 404, not 403.
 */
import {
  deletePool,
  getPool,
  poolIdParamSchema,
  updatePool,
  updatePoolSchema,
} from "@/server/services/inventory";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseParams } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { poolId: string };

export const GET = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  const { poolId } = parseParams(params, poolIdParamSchema);
  return jsonOk(await getPool(ctx, poolId), requestId);
});

export const PATCH = route<Params>(async (request, { requestId, context, params }) => {
  const ctx = await context();
  const { poolId } = parseParams(params, poolIdParamSchema);
  const body = await parseBody(request, updatePoolSchema);
  return jsonOk(await updatePool(ctx, poolId, body), requestId);
});

export const DELETE = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  const { poolId } = parseParams(params, poolIdParamSchema);
  await deletePool(ctx, poolId);
  return new Response(null, { status: 204, headers: { "x-request-id": requestId } });
});
