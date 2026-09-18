/**
 * GET /api/v1/workspace-templates — the business templates a tenant can set
 * their workspace up from ("Graft Hotel", "Graft Salon", …), as gallery cards.
 *
 * Thin by contract (docs/BACKEND.md §1): the library is static content, but
 * the read still goes through `context()` so it is authenticated and charged
 * to the tenant's rate-limit budget like every other API read.
 */
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { listWorkspaceTemplates } from "@/server/services/workspace-templates";

export const dynamic = "force-dynamic";

export const GET = route(async (_request, { requestId, context }) => {
  await context();
  return jsonOk(listWorkspaceTemplates(), requestId);
});
