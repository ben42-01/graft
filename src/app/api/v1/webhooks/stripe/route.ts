/**
 * POST /api/v1/webhooks/stripe — Stripe's only entry point into tier state
 * (GRAFT-15). PROTECTED PATH (.github/agent-policy.yml): approved for this
 * issue — see the Constraints section of GRAFT-15 and the
 * `agent:co-review-approved` label.
 *
 * Unauthenticated by necessity (nothing but a valid Stripe signature proves a
 * call here is real, docs/BACKEND.md §3.2) and therefore rate-limited on IP
 * alone (AC7), the same as every other anonymous surface. The raw body is
 * read before anything else touches the request: signature verification is
 * over the exact bytes Stripe sent, and a JSON round-trip would invalidate it
 * (Constraints — "the raw body must not be consumed by body-parsing
 * middleware before verification"). There is no such middleware in this app,
 * but the ordering here is what keeps that true.
 */
import { handleStripeWebhookEvent } from "@/server/services/billing";
import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";

export const dynamic = "force-dynamic";

export const POST = route(
  async (request, { requestId }) => {
    const payload = await request.text();
    const signature = request.headers.get("stripe-signature");
    await handleStripeWebhookEvent(payload, signature);
    // AC7 — nothing about the tenant, ever, in the response body.
    return jsonOk({ received: true }, requestId);
  },
  { rateLimit: { scopes: ["global-ip"] } },
);
