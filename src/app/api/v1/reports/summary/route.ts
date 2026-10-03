/**
 * GET /api/v1/reports/summary — the Overview's headline numbers: open orders,
 * what is owed, the last 30 days against the 30 before, and customer counts.
 *
 * Available on every tier. The trend and the breakdowns behind these figures
 * are GET /api/v1/reports/sales, which is Premium.
 */
import { getBusinessSummary } from "@/server/services/sales-report";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";

export const dynamic = "force-dynamic";

export const GET = route(async (_request, { requestId, context }) => {
  const ctx = await context();
  return jsonOk(await getBusinessSummary(ctx), requestId);
});
