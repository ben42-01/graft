/**
 * GET /api/v1/inventory/allocations — what the master schedule reads
 * (docs/BMS_EXTENSION.md §2.3).
 *
 * `from`/`to` filter on the *blocked* window rather than the booked one, so a
 * timeline drawn from this shows buffer blocks as the occupied time they
 * actually are.
 */
import { listAllocations, listAllocationsQuerySchema } from "@/server/services/availability";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseQuery } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const GET = route(async (request, { requestId, context }) => {
  const ctx = await context();
  const query = parseQuery(request, listAllocationsQuerySchema);
  const { items, meta } = await listAllocations(ctx, query);
  return jsonOk(items, requestId, meta);
});
