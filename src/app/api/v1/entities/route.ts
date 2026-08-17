/**
 * POST/GET /api/v1/entities — tenant-defined entity CRUD, list side (GRAFT-06).
 *
 * Thin by contract (docs/BACKEND.md §1): parse, delegate, envelope. Every
 * decision — quota, duplicate keys, schema compilation — lives in
 * src/server/services/entities.ts.
 */
import {
  createEntity,
  createEntitySchema,
  listEntities,
  listEntitiesQuerySchema,
} from "@/server/services/entities";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseQuery } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const POST = route(async (request, { requestId, context }) => {
  const ctx = await context();
  const body = await parseBody(request, createEntitySchema);
  const entity = await createEntity(ctx, body);
  return jsonOk(entity, requestId, undefined, { status: 201 });
});

export const GET = route(async (request, { requestId, context }) => {
  const ctx = await context();
  const query = parseQuery(request, listEntitiesQuerySchema);
  const { items, meta } = await listEntities(ctx, query);
  return jsonOk(items, requestId, meta);
});
