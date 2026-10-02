/**
 * GET /api/v1/customers/:customerId — one customer: their contact details,
 * what they have spent and still owe, and every order they placed.
 *
 * `customerId` is any record id belonging to the customer — never an email,
 * which would put an address into access logs.
 */
import { customerIdParamSchema, getCustomer } from "@/server/services/customers";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseParams } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { customerId: string };

export const GET = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  const { customerId } = parseParams(params, customerIdParamSchema);
  return jsonOk(await getCustomer(ctx, customerId), requestId);
});
