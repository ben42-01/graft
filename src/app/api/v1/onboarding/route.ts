/**
 * GET/PATCH /api/v1/onboarding — the wizard's step + answers, tenant-scoped
 * (GRAFT-12 AC2, AC7). Thin by contract (docs/BACKEND.md §1): every decision
 * lives in src/server/services/onboarding.ts.
 */
import {
  getOnboardingState,
  patchOnboardingSchema,
  patchOnboardingState,
} from "@/server/services/onboarding";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const GET = route(async (_request, { requestId, context }) => {
  const ctx = await context();
  return jsonOk(await getOnboardingState(ctx), requestId);
});

export const PATCH = route(async (request, { requestId, context }) => {
  const ctx = await context();
  const body = await parseBody(request, patchOnboardingSchema);
  return jsonOk(await patchOnboardingState(ctx, body), requestId);
});
