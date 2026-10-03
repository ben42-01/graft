/**
 * PUT/DELETE /api/v1/orders/:orderId/payment-link — the link the customer
 * pays this order through: a Stripe Payment Link or hosted invoice the tenant
 * made in their own dashboard for the order's amount.
 *
 * Graft only points at it. Nothing here talks to Stripe, and a payment made
 * through the link is recorded the same way as any other
 * (POST /orders/:orderId/payments).
 */
import {
  orderIdParamSchema,
  setOrderPaymentLink,
  setPaymentLinkSchema,
} from "@/server/services/orders";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseParams } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { orderId: string };

export const PUT = route<Params>(async (request, { requestId, context, params }) => {
  const ctx = await context();
  const { orderId } = parseParams(params, orderIdParamSchema);
  const body = await parseBody(request, setPaymentLinkSchema);
  return jsonOk(await setOrderPaymentLink(ctx, orderId, body), requestId);
});

export const DELETE = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  const { orderId } = parseParams(params, orderIdParamSchema);
  return jsonOk(await setOrderPaymentLink(ctx, orderId, { url: null }), requestId);
});
