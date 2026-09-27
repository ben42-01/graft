/**
 * POST /api/v1/webhooks/stripe-connect — events from tenants' *connected*
 * accounts: a Checkout Session paid on a form, an account finishing
 * onboarding. A separate endpoint (and signing secret) from billing's
 * /webhooks/stripe, which carries Graft's own subscription events and is a
 * protected path this deliberately does not touch.
 *
 * Unauthenticated by necessity; the Stripe signature is the only proof. The
 * raw body is read first because the signature is over the exact bytes, and
 * the tenant an event acts on is proved by the account it came from
 * (`handleConnectWebhookEvent`), never by its metadata alone.
 */
import { handleConnectWebhookEvent } from "@/server/services/stripe-connect";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";

export const dynamic = "force-dynamic";

export const POST = route(
  async (request, { requestId }) => {
    const payload = await request.text();
    const signature = request.headers.get("stripe-signature");
    await handleConnectWebhookEvent(payload, signature, requestId);
    return jsonOk({ received: true }, requestId);
  },
  { rateLimit: { scopes: ["global-ip"] } },
);
