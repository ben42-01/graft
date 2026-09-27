/**
 * GET    /api/v1/payments/stripe-connect — whether this workspace can take card
 *        payments through Stripe Checkout, refreshed from Stripe while
 *        onboarding is unfinished.
 * DELETE /api/v1/payments/stripe-connect — forget the connected account
 *        (owner/admin). The Stripe account itself stays the tenant's.
 *
 * Everything that matters lives in src/server/services/stripe-connect.ts.
 */
import { disconnectStripe, getConnectStatus } from "@/server/services/stripe-connect";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";

export const dynamic = "force-dynamic";

export const GET = route(async (_request, { requestId, context }) => {
  return jsonOk(await getConnectStatus(await context()), requestId);
});

export const DELETE = route(async (_request, { requestId, context }) => {
  return jsonOk(await disconnectStripe(await context()), requestId);
});
