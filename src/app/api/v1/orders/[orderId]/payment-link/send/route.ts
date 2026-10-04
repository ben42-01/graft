/**
 * POST /api/v1/orders/:orderId/payment-link/send — emails the order's payment
 * link to its customer, from Graft, with replies going to the sender. No body:
 * the address and the link are the order's own (see order-emails.ts).
 */
import { orderIdParamSchema } from "@/server/services/orders";
import { sendOrderPaymentLink } from "@/server/services/order-emails";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseParams } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { orderId: string };

export const POST = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  const { orderId } = parseParams(params, orderIdParamSchema);
  return jsonOk(await sendOrderPaymentLink(ctx, orderId), requestId);
});
