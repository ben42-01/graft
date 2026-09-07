/**
 * POST /api/v1/inventory/pools/:poolId/holds — the pessimistic time-lock of
 * docs/BMS_EXTENSION.md §2.1.
 *
 * Takes a short lease on capacity so a customer filling in a checkout form
 * cannot have the resource sold out from under them. The lease expires on its
 * own; nothing has to clean it up for availability to be correct again.
 *
 * Errors: 404 NOT_FOUND (wrong tenant, or no such pool), 409 CONFLICT (not
 * available for that window, or the pool does not take holds), 400
 * VALIDATION_FAILED (an end before its start, or a range beyond a year).
 */
import { holdResource, holdSchema } from "@/server/services/availability";
import { poolIdParamSchema } from "@/server/services/inventory";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseParams } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { poolId: string };

export const POST = route<Params>(async (request, { requestId, context, params }) => {
  const ctx = await context();
  const { poolId } = parseParams(params, poolIdParamSchema);
  const body = await parseBody(request, holdSchema);
  const allocation = await holdResource(ctx, poolId, body);
  return jsonOk(allocation, requestId, undefined, { status: 201 });
});
