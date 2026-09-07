# Graft — Stripe Test-Mode Setup

**Status:** In progress — picking this up later to test the Pro (Premium) upgrade flow end-to-end.
See [[docs/TIERS.md]] §3 for the pricing this catalog implements.

## Why a dedicated Stripe account

Billing must be tested against a Stripe account of its own, not whatever
personal/other-business account happens to be logged into the CLI. A
**sandbox** (Dashboard → account switcher → a sandbox under one account) is
*not* enough isolation for this — it's still nested under someone else's
business account. Graft has its own standalone Stripe account instead
("Graft", test mode only used so far).

## Done so far

- Created a new, separate Stripe account named **"Graft"** (not a sandbox of
  another account) via Dashboard → account switcher → "+ Create a new
  account".
- Logged the Stripe CLI into that account's key (`stripe login`, later
  swapped to the Graft account's `sk_test_...` via `--api-key`).
- Created the product catalog in **test mode**, matching `docs/TIERS.md` §3
  pricing (€29/mo, €290/yr):

  | | id |
  |---|---|
  | Product "Graft Premium" | `prod_V77uHDhlwYEXYh` |
  | Price "Premium Monthly" (€29.00/mo, EUR) | `price_1U6teV74G5LPLMfkPmhx7aJ2` |
  | Price "Premium Annual" (€290.00/yr, EUR) | `price_1U6teV74G5LPLMfkS069E7c7` |

  These map directly to `STRIPE_PRICE_PREMIUM_MONTHLY` /
  `STRIPE_PRICE_PREMIUM_ANNUAL` in `src/server/services/billing.ts`'s
  `billingEnvSchema`.

## What's left

1. **Get the webhook signing secret.** `stripe listen` needs to actually run
   (a live process, not something to background) — this got blocked by the
   permission classifier when attempted headlessly, so it needs a human
   terminal:

   ```
   stripe listen --forward-to localhost:3000/api/v1/webhooks/stripe --print-secret
   ```

   Copy the printed `whsec_...` value.

2. **Fill in `.env.dev`** (already gitignored, never commit real keys) with
   the real test-mode values, replacing the dummy placeholders:

   ```
   STRIPE_SECRET_KEY=sk_test_...          # Graft account, Dashboard → Developers → API keys
   STRIPE_WEBHOOK_SECRET=whsec_...        # from step 1
   STRIPE_PRICE_PREMIUM_MONTHLY=price_1U6teV74G5LPLMfkPmhx7aJ2
   STRIPE_PRICE_PREMIUM_ANNUAL=price_1U6teV74G5LPLMfkS069E7c7
   ```

3. **Keep `stripe listen --forward-to localhost:3000/api/v1/webhooks/stripe`
   running** in its own terminal for the whole test session — it forwards
   Checkout/subscription webhook events to the local dev server at `:3000`
   (per [[ui-refinement-branch]], the dev server is the user's, already
   running — don't start/stop it).

4. **Restart `npm run dev`** after changing `.env.dev` so the new billing env
   is picked up (env vars are read at process start).

5. **Run the actual upgrade flow**: sign in → hit the checkout route
   (`src/app/api/v1/billing/checkout/route.ts`) → Stripe test Checkout page →
   pay with a Stripe test card (`4242 4242 4242 4242`, any future expiry, any
   CVC) → confirm the webhook (`src/app/api/v1/webhooks/stripe/route.ts`)
   flips the tenant to `premium` and the UI reflects it (nav gating,
   `gated-control.tsx`, entitlements).

6. Test the downgrade/cancellation and `invoice.payment_failed` grace-period
   path too (`GRACE_PERIOD_MS` in `billing.ts`) — a failed payment should not
   delete anything, only freeze over-limit resources read-only.
