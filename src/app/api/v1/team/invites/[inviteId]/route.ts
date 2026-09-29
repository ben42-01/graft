/**
 * DELETE /api/v1/team/invites/:inviteId — revoke a pending invite (GRAFT-33.1
 * AC6). Another tenant's invite is invisible to the scoped repository: 404.
 */
import { revokeInvite } from "@/server/services/team";
import { route } from "@/server/http/handler";

export const dynamic = "force-dynamic";

type Params = { inviteId: string };

export const DELETE = route<Params>(async (_request, { requestId, context, params }) => {
  const ctx = await context();
  await revokeInvite(ctx, params.inviteId);
  return new Response(null, { status: 204, headers: { "x-request-id": requestId } });
});
