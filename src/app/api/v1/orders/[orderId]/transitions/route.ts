/**
 * POST /api/v1/orders/:orderId/transitions — the state machine's only door
 * (docs/BMS_EXTENSION.md §2.2).
 *
 * A POST rather than a PATCH on the order: moving state is an event with
 * consequences beyond the document (confirming carries the order's allocations
 * with it; cancelling releases them), not a field being edited.
 *
 * Errors: 409 CONFLICT names both states and lists what *is* allowed from
 * here, so a client never has to guess the graph.
 */
import {
  orderIdParamSchema,
  transitionOrder,
  transitionOrderSchema,
} from "@/server/services/orders";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseParams } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { orderId: string };

export const POST = route<Params>(async (request, { requestId, context, params }) => {
  const ctx = await context();
  const { orderId } = parseParams(params, orderIdParamSchema);
  const body = await parseBody(request, transitionOrderSchema);
  return jsonOk(await transitionOrder(ctx, orderId, body), requestId);
});
