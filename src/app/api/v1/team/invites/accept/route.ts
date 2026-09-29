/**
 * POST /api/v1/team/invites/accept — a signed-in user takes the seat an invite
 * link offers (GRAFT-33.2 AC1–AC5, AC8). Authenticated, on the ordinary
 * authenticated rate-limit scopes; the tenant and role come from the invite
 * row, never from anything in the request.
 */
import { acceptInvite } from "@/server/services/team";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";

export const dynamic = "force-dynamic";

export const POST = route(async (request, { requestId, context }) => {
  const ctx = await context();
  const body: unknown = await request.json().catch(() => undefined);
  return jsonOk(await acceptInvite(ctx, body), requestId);
});
