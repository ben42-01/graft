/**
 * POST /api/v1/billing/checkout — starts a Stripe Checkout session for
 * Premium monthly/annual (GRAFT-15 AC1, AC7). Owner-only; the actual tier
 * transition happens asynchronously once Stripe calls the webhook
 * (src/app/api/v1/webhooks/stripe/route.ts) — this endpoint only ever hands
 * back a URL to redirect to.
 */
import { checkoutSchema, createCheckoutSession } from "@/server/services/billing";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";
import { parseBody } from "@/server/http/validate";

export const dynamic = "force-dynamic";

export const POST = route(async (request, { requestId, context }) => {
  const ctx = await context();
  const body = await parseBody(request, checkoutSchema);
  const result = await createCheckoutSession(ctx, body);
  return jsonOk(result, requestId);
});
