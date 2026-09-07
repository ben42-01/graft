/**
 * GET /api/v1/orders/:orderId/ledger — the order, every invoice against it,
 * and what is still outstanding (docs/BMS_EXTENSION.md §2.3's "Invoicing &
 * Ledger" panel).
 */
import { ledgerForOrder } from "@/server/services/invoices";
import { orderIdParamSchema } from "@/server/services/orders";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseParams } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { orderId: string };

export const GET = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  const { orderId } = parseParams(params, orderIdParamSchema);
  return jsonOk(await ledgerForOrder(ctx, orderId), requestId);
});
