/**
 * DELETE /api/v1/team/members/:userId — remove someone from this workspace
 * (GRAFT-33.1 AC7). Only this tenant's membership goes; the owner cannot
 * remove themselves, and someone who is not a member here is 404.
 */
import { removeMember } from "@/server/services/team";
import { route } from "@/server/http/handler";

export const dynamic = "force-dynamic";

type Params = { userId: string };

export const DELETE = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  await removeMember(ctx, params.userId);
  return new Response(null, { status: 204, headers: { "x-request-id": requestId } });
});
