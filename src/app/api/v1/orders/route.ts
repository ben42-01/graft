/**
 * GET/POST /api/v1/orders (docs/BMS_EXTENSION.md §2.2).
 *
 * An order is created as a `draft` — priced once, from the line items given —
 * and moves through the state machine via
 * POST /api/v1/orders/:orderId/transitions.
 */
import { createOrder, createOrderSchema, listOrders } from "@/server/services/orders";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseQuery } from "@/server/http/validate";
import { listOrdersQuerySchema } from "@/server/services/orders";

export const dynamic = "force-dynamic";

export const GET = route(async (request, { requestId, context }) => {
  const ctx = await context();
  const query = parseQuery(request, listOrdersQuerySchema);
  const { items, meta } = await listOrders(ctx, query);
  return jsonOk(items, requestId, meta);
});

export const POST = route(async (request, { requestId, context }) => {
  const ctx = await context();
  const body = await parseBody(request, createOrderSchema);
  const order = await createOrder(ctx, body);
  return jsonOk(order, requestId, undefined, { status: 201 });
});
