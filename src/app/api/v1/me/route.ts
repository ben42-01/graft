/**
 * GET /api/v1/me — identity and entitlement in one read (AC7).
 *
 * The single object the UI reads to decide what to render: who you are, which
 * workspaces you can switch to, and the active tenant's tier and materialised
 * limits. Tier gating itself is still a server-side decision (GRAFT-05) — this
 * endpoint tells the client what to *show*, never what it is allowed to do.
 */
import { getMe } from "@/server/services/accounts";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";

export const dynamic = "force-dynamic";

export const GET = route(async (_request, { requestId, context }) => {
  const ctx = await context();
  return jsonOk(await getMe(ctx), requestId);
});
