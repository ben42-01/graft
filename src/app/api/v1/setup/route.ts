/**
 * GET/POST/PATCH /api/v1/setup — the guided setup run in progress,
 * tenant-scoped. Thin by contract (docs/BACKEND.md §1): every decision lives
 * in src/server/services/setup-runs.ts.
 *
 * GET answers `null` for a tenant with nothing open, which is a real answer
 * and not a 404: "you have no run open" is what the page needs in order to
 * offer starting one.
 */
import {
  getActiveSetupRun,
  patchSetupRun,
  patchSetupRunSchema,
  startSetupRun,
} from "@/server/services/setup-runs";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const GET = route(async (_request, { requestId, context }) => {
  const ctx = await context();
  return jsonOk(await getActiveSetupRun(ctx), requestId);
});

export const POST = route(async (_request, { requestId, context }) => {
  const ctx = await context();
  return jsonOk(await startSetupRun(ctx), requestId);
});

export const PATCH = route(async (request, { requestId, context }) => {
  const ctx = await context();
  const body = await parseBody(request, patchSetupRunSchema);
  return jsonOk(await patchSetupRun(ctx, body), requestId);
});
