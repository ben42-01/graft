/**
 * GET /api/v1/public/invites/:token — what the invite landing page needs to
 * say "Join Harbour Boats as a Member" (GRAFT-33.2 AC7). Unauthenticated, and
 * rate limited on the ip-keyed public scopes by the /public/ row in
 * rate-limit/policy.ts. Anything invalid is one 404 with no reason.
 */
import { previewInvite } from "@/server/services/team";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";

export const dynamic = "force-dynamic";

type Params = { token: string };

export const GET = route<Params>(async (_request, { requestId, params }) =>
  jsonOk(await previewInvite(params.token), requestId),
);
