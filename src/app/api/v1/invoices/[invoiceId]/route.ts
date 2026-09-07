/**
 * GET/PATCH /api/v1/invoices/:invoiceId.
 *
 * There is deliberately no DELETE and no content edit: an issued invoice is
 * marked `paid` or `void` and nothing else. A wrong invoice is voided and
 * replaced, which is what leaves the trail an accountant expects.
 */
import {
  getInvoice,
  invoiceIdParamSchema,
  updateInvoiceSchema,
  updateInvoiceStatus,
} from "@/server/services/invoices";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseParams } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { invoiceId: string };

export const GET = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  const { invoiceId } = parseParams(params, invoiceIdParamSchema);
  return jsonOk(await getInvoice(ctx, invoiceId), requestId);
});

export const PATCH = route<Params>(async (request, { requestId, context, params }) => {
  const ctx = await context();
  const { invoiceId } = parseParams(params, invoiceIdParamSchema);
  const body = await parseBody(request, updateInvoiceSchema);
  return jsonOk(await updateInvoiceStatus(ctx, invoiceId, body), requestId);
});
