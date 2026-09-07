/**
 * GET /api/v1/inventory/pools/:poolId/availability?startAt=&endAt=&quantity=
 *
 * The overbooking-protection API of docs/BMS_EXTENSION.md §2.1, exposed
 * directly: one question, one answer, no side effects. Deliberately read-only
 * and racy — the answer is true at the instant it is given. A checkout that
 * needs the answer to *stay* true takes a hold (POST .../holds), which asks
 * the same question again inside a transaction.
 */
import { availabilityQuerySchema, isAvailable } from "@/server/services/availability";
import { poolIdParamSchema } from "@/server/services/inventory";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseParams, parseQuery } from "@/server/http/validate";

export const dynamic = "force-dynamic";

type Params = { poolId: string };

export const GET = route<Params>(async (request, { requestId, context, params }) => {
  const ctx = await context();
  const { poolId } = parseParams(params, poolIdParamSchema);
  // Parsed here so a malformed range is a 400 before any pool is loaded, then
  // handed on as already-coerced Dates — `isAvailable` re-parses, which the
  // schema tolerates, so the service stays callable without a Request.
  const query = parseQuery(request, availabilityQuerySchema);
  return jsonOk(await isAvailable(ctx, poolId, query), requestId);
});
