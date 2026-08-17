/**
 * POST/GET /api/v1/forms — form CRUD, list side (GRAFT-08).
 *
 * Thin by contract (docs/BACKEND.md §1): parse, delegate, envelope. Every
 * decision — entity binding, field whitelisting, quota — lives in
 * src/server/services/forms.ts.
 */
import {
  createForm,
  createFormSchema,
  listForms,
  listFormsQuerySchema,
} from "@/server/services/forms";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody, parseQuery } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const POST = route(async (request, { requestId, context }) => {
  const ctx = await context();
  const body = await parseBody(request, createFormSchema);
  const form = await createForm(ctx, body);
  return jsonOk(form, requestId, undefined, { status: 201 });
});

export const GET = route(async (request, { requestId, context }) => {
  const ctx = await context();
  const query = parseQuery(request, listFormsQuerySchema);
  const { items, meta } = await listForms(ctx, query);
  return jsonOk(items, requestId, meta);
});
