/**
 * GET/POST /api/v1/inventory/pools (docs/BMS_EXTENSION.md §2.1, Step 1).
 *
 * A pool is the bookable-ness of one record: which strategy governs it, how
 * much of it there is, and how long it needs between bookings.
 */
import {
  createPool,
  createPoolSchema,
  listPools,
  listPoolsQuerySchema,
} from "@/server/services/inventory";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseQuery } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const GET = route(async (request, { requestId, context }) => {
  const ctx = await context();
  const query = parseQuery(request, listPoolsQuerySchema);
  const { items, meta } = await listPools(ctx, query);
  return jsonOk(items, requestId, meta);
});

export const POST = route(async (request, { requestId, context }) => {
  const ctx = await context();
  const body = await parseBody(request, createPoolSchema);
  const pool = await createPool(ctx, body);
  return jsonOk(pool, requestId, undefined, { status: 201 });
});
