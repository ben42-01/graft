/**
 * GET /api/v1/customers — everyone who has ordered, with what they have spent.
 *
 * Customers are derived, not stored: the orders that share a contact email
 * are one customer (src/server/services/customers.ts). `q` searches name,
 * email and phone; `sort` is `recent` (default), `spend` or `orders`.
 */
import { listCustomers, listCustomersQuerySchema } from "@/server/services/customers";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseQuery } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const GET = route(async (request, { requestId, context }) => {
  const ctx = await context();
  const query = parseQuery(request, listCustomersQuerySchema);
  const { items, meta } = await listCustomers(ctx, query);
  return jsonOk(items, requestId, meta);
});
