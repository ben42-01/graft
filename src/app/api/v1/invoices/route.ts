/**
 * GET/POST /api/v1/invoices (docs/BMS_EXTENSION.md §2.2).
 *
 * POST issues an invoice against an order — a snapshot of its line items and
 * totals, numbered sequentially per tenant. `kind` picks which document this
 * is: the whole order, its deposit, or the balance.
 */
import {
  issueInvoice,
  issueInvoiceSchema,
  listInvoices,
  listInvoicesQuerySchema,
} from "@/server/services/invoices";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseQuery } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const GET = route(async (request, { requestId, context }) => {
  const ctx = await context();
  const query = parseQuery(request, listInvoicesQuerySchema);
  const { items, meta } = await listInvoices(ctx, query);
  return jsonOk(items, requestId, meta);
});

export const POST = route(async (request, { requestId, context }) => {
  const ctx = await context();
  const body = await parseBody(request, issueInvoiceSchema);
  const invoice = await issueInvoice(ctx, body);
  return jsonOk(invoice, requestId, undefined, { status: 201 });
});
