/**
 * GET /api/v1/reports/usage?meter=... — the Chart widget's data source
 * (GRAFT-13 AC3, AC5). Thin: the Premium gate and the meter read both live in
 * src/server/services/reports.ts, so this route cannot forget either one.
 */
import { z } from "zod";
import { METERS, type Meter } from "@/server/services/meters";
import { getMeterUsage } from "@/server/services/reports";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseQuery } from "@/server/http/validate";

export const dynamic = "force-dynamic";

const querySchema = z.object({ meter: z.enum(Object.keys(METERS) as [Meter, ...Meter[]]) });

export const GET = route(async (request, { requestId, context }) => {
  const ctx = await context();
  const { meter } = parseQuery(request, querySchema);
  const usage = await getMeterUsage(ctx, meter);
  return jsonOk(usage, requestId);
});
