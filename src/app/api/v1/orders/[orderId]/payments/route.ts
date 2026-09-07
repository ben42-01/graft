/**
 * POST /api/v1/orders/:orderId/payments — record money received
 * (docs/BMS_EXTENSION.md §2.2, "Split & Deposit Payments").
 *
 * The caller says how much arrived and nothing more. Whether that is enough to
 * confirm the order is the service's decision, made against the order's own
 * deposit — a payment provider knows amounts, not business rules.
 */
import {
  orderIdParamSchema,
  recordPayment,
  recordPaymentSchema,
} from "@/server/services/orders";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseParams } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { orderId: string };

export const POST = route<Params>(async (request, { requestId, context, params }) => {
  const ctx = await context();
  const { orderId } = parseParams(params, orderIdParamSchema);
  const body = await parseBody(request, recordPaymentSchema);
  return jsonOk(await recordPayment(ctx, orderId, body), requestId, undefined, {
    status: 201,
  });
});
