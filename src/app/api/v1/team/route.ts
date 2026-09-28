/**
 * GET /api/v1/team — members, pending invites and seats (GRAFT-33.1 AC5).
 * Owner only (AC4); every decision lives in src/server/services/team.ts.
 */
import { getTeam } from "@/server/services/team";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";

export const dynamic = "force-dynamic";

export const GET = route(async (_request, { requestId, context }) => {
  const ctx = await context();
  return jsonOk(await getTeam(ctx), requestId);
});
