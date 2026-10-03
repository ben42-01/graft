/**
 * GET /api/v1/submissions — the inbox: every form submission, newest first,
 * with the form it came through, who sent it and the order it raised.
 *
 * `formId` narrows it to one form. Cursor-paged like every other list.
 */
import { listSubmissions, listSubmissionsQuerySchema } from "@/server/services/submissions";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseQuery } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const GET = route(async (request, { requestId, context }) => {
  const ctx = await context();
  const query = parseQuery(request, listSubmissionsQuerySchema);
  const { items, meta } = await listSubmissions(ctx, query);
  return jsonOk(items, requestId, meta);
});
