/**
 * GET /api/v1/meters/:meter — a tenant's own usage against one meter, for the
 * KPI widget (GRAFT-13 AC3). Every tier can read its own meters; this is a
 * peek, never an increment (src/server/services/meters.ts `peekQuota`), and
 * it is already tenant-scoped by `ctx` — there is no cross-tenant path here.
 */
import { z } from "zod";
import { METERS, peekQuota, type Meter } from "@/server/services/meters";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseParams } from "@/server/http/validate";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ meter: z.enum(Object.keys(METERS) as [Meter, ...Meter[]]) });

type Params = { meter: string };

export const GET = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  const { meter } = parseParams(params, paramsSchema);
  const usage = await peekQuota(ctx, meter);
  return jsonOk(usage, requestId);
});
