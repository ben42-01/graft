/**
 * GET /api/v1/reports/sales?from=&to=&currency= — sales over a window: a
 * daily series, best sellers, which form the orders came through and how many
 * customers came back (docs/TIERS.md §2.4 — Reports are Premium+).
 *
 * Defaults to the last 30 days; at most a year. The Premium gate lives in
 * src/server/services/sales-report.ts, so this route cannot forget it.
 */
import { getSalesReport, salesReportQuerySchema } from "@/server/services/sales-report";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseQuery } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const GET = route(async (request, { requestId, context }) => {
  const ctx = await context();
  const query = parseQuery(request, salesReportQuerySchema);
  return jsonOk(await getSalesReport(ctx, query), requestId);
});
