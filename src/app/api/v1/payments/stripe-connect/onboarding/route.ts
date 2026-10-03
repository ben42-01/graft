/**
 * POST /api/v1/payments/stripe-connect/onboarding — a Stripe-hosted onboarding
 * link for this workspace's connected account, creating the account on first
 * use (owner/admin). The body names an in-app page to come back to; anything
 * else is refused, so this can never be used as an open redirect. `country`
 * (ISO alpha-2, default IE) is used only when the account is created.
 */
import { onboardingSchema, startConnectOnboarding } from "@/server/services/stripe-connect";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const POST = route(async (request, { requestId, context }) => {
  const ctx = await context();
  const body = await parseBody(request, onboardingSchema);
  return jsonOk(await startConnectOnboarding(ctx, body), requestId);
});
