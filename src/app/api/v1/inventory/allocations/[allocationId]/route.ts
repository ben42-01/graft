/**
 * PATCH  /api/v1/inventory/allocations/:allocationId — move a hold along the
 *        lifecycle: confirm it, release it, or cancel a confirmed booking.
 * DELETE /api/v1/inventory/allocations/:allocationId — the same as releasing,
 *        for a client that would rather say "delete".
 *
 * Nothing is ever really deleted: an allocation is the record of what happened
 * to a resource, and a released row is what says the capacity came back.
 */
import { z } from "zod";
import {
  allocationIdParamSchema,
  confirmAllocation,
  releaseAllocation,
} from "@/server/services/availability";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseParams } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { allocationId: string };

const patchSchema = z.object({
  status: z.enum(["confirmed", "released", "cancelled"]),
  /** The order this allocation now belongs to, set as it is confirmed. */
  holderId: z
    .string()
    .regex(/^[0-9a-f]{24}$/i, "Expected a 24-character id")
    .optional(),
});

export const PATCH = route<Params>(async (request, { requestId, context, params }) => {
  const ctx = await context();
  const { allocationId } = parseParams(params, allocationIdParamSchema);
  const body = await parseBody(request, patchSchema);

  const allocation =
    body.status === "confirmed"
      ? await confirmAllocation(ctx, allocationId, body.holderId)
      : await releaseAllocation(ctx, allocationId, body.status);
  return jsonOk(allocation, requestId);
});

export const DELETE = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  const { allocationId } = parseParams(params, allocationIdParamSchema);
  return jsonOk(await releaseAllocation(ctx, allocationId, "released"), requestId);
});
