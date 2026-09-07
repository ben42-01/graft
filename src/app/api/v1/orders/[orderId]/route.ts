/**
 * GET/PATCH/DELETE /api/v1/orders/:orderId.
 *
 * PATCH edits only a `draft`: once a customer has been asked for money, the
 * line items are what they agreed to. DELETE cancels first (releasing the
 * order's allocations) and then soft-deletes — an order is a financial record,
 * so there is no hard delete.
 */
import {
  deleteOrder,
  getOrder,
  orderIdParamSchema,
  updateOrder,
  updateOrderSchema,
} from "@/server/services/orders";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseParams } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { orderId: string };

export const GET = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  const { orderId } = parseParams(params, orderIdParamSchema);
  return jsonOk(await getOrder(ctx, orderId), requestId);
});

export const PATCH = route<Params>(async (request, { requestId, context, params }) => {
  const ctx = await context();
  const { orderId } = parseParams(params, orderIdParamSchema);
  const body = await parseBody(request, updateOrderSchema);
  return jsonOk(await updateOrder(ctx, orderId, body), requestId);
});

export const DELETE = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  const { orderId } = parseParams(params, orderIdParamSchema);
  await deleteOrder(ctx, orderId);
  return new Response(null, { status: 204, headers: { "x-request-id": requestId } });
});
