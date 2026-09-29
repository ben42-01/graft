/**
 * POST /api/v1/team/invites — the owner creates an invite link (GRAFT-33.1
 * AC1–AC4). The raw token appears once, inside `url`, and is never stored.
 *
 * The body is handed to the service unparsed: the owner check runs before
 * validation, so a non-owner gets 403 whatever they sent (AC4). Unparseable
 * JSON arrives as `undefined` and fails the schema as VALIDATION_FAILED.
 */
import { createInvite } from "@/server/services/team";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";

export const dynamic = "force-dynamic";

export const POST = route(async (request, { requestId, context }) => {
  const ctx = await context();
  const body: unknown = await request.json().catch(() => undefined);
  return jsonOk(await createInvite(ctx, body), requestId, undefined, { status: 201 });
});
