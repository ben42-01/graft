# Graft — Stripe Test-Mode Setup

**Status:** Catalog and keys in place; runbook below checked against the code on 2026-09-18. The only missing value is the local webhook signing secret (step 1).
See [[docs/TIERS.md]] §3 for the pricing this catalog implements.

## Not to be confused with: tenant payment links

Everything in this document is **Graft's own** Stripe account — tenants paying
Graft for Premium ([[docs/TIERS.md]] §3). A tenant collecting money from *their*
customer on a public form is a different thing entirely: they paste a Stripe
Payment Link from their own Stripe account into the form builder, and Graft
redirects the submitter to it ([[docs/Graft.md]] §4.4, "Customer Payments").
That path stores no tenant credential, calls no Stripe API, and receives no
webhook — it handles a public URL and nothing else. The two never meet, and no
key or webhook secret below is ever read by it.

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

## Checked against the code (2026-09-18)

| | State |
|---|---|
| `STRIPE_SECRET_KEY` in `.env.dev` | ✅ real `sk_test_…`. Stripe reports the account as **"Graft sandbox"** (`acct_1U6tbx74G5LPLMfk`) — confirm in the dashboard that this is the standalone "Graft" account described above and not a sandbox nested under another business. |
| `STRIPE_PRICE_PREMIUM_MONTHLY` / `_ANNUAL` | ✅ both active in that account, test mode: €29.00/month, €290.00/year |
| `STRIPE_WEBHOOK_SECRET` in `.env.dev` | ❌ still the QA fixture placeholder (`whsec_qa_fix…`) — every real webhook is rejected as "Invalid Stripe signature" until step 1 is done |
| `APP_URL` | ✅ `http://localhost:3000` — Checkout returns to `/billing/success` or `/billing/cancel` on it |
| Webhook events acted on | `checkout.session.completed` (→ Premium), `customer.subscription.updated` with status `active`/`trialing` (→ Premium, clears any grace period), `customer.subscription.deleted` (→ Free via the downgrade policy), `invoice.payment_failed` (→ 7-day grace period, still Premium). Everything else is accepted and ignored. |

Three things about the product that shape how a first run goes:

- **A new sign-up is already Premium.** Signup starts a 14-day Premium trial (`startTrial`, no card). The *Upgrade to Premium* button on `/account` only shows on **Free**, so a freshly created tenant has no upgrade button until its trial ends — step 3 below ends it on purpose.
- **There is no in-app "manage / cancel subscription".** No Stripe customer portal is wired; cancelling happens in the Stripe dashboard or CLI.
- **Neither expiry job is scheduled.** Trial expiry (`scripts/expire-trials.ts`) and grace-period expiry (`expireDueGracePeriods`, no script at all) are run by hand — see steps 3 and 8.

## Runbook — first subscription run on dev

All commands run from the repo root. The helpers read `.env.dev`, so they only
ever touch the dev database. Replace `my-shop` with your tenant's slug (the
business name, slugified — it is also the first part of its public form URLs).

**0. Stack up.** `npm run dev:full` (or `dev:db` + `dev:seed` + `dev`).

**1. Webhook secret — once per machine.** Use the key from `.env.dev` so the CLI
talks to the Graft account, not whatever account `stripe login` last used:

```bash
STRIPE_KEY=$(grep '^STRIPE_SECRET_KEY=' .env.dev | cut -d= -f2-)
stripe listen --api-key "$STRIPE_KEY" --print-secret
```

`--print-secret` prints the `whsec_…` and exits. Put it in `.env.dev` as
`STRIPE_WEBHOOK_SECRET=…`, then **restart `npm run dev`** (billing env is read
once and cached for the life of the process). The secret stays the same for
this key on this machine, so this is a one-time step.

**2. Forward webhooks — every session.** In its own terminal, left running:

```bash
STRIPE_KEY=$(grep '^STRIPE_SECRET_KEY=' .env.dev | cut -d= -f2-)
stripe listen --api-key "$STRIPE_KEY" --forward-to localhost:3000/api/v1/webhooks/stripe
```

Each forwarded event prints with the status your app answered — you want
`[200]`. A `[400]` means the secret in `.env.dev` doesn't match (redo step 1
and restart the dev server).

**3. A tenant on Free.** Sign up a new business (it starts on the Premium
trial), then end the trial and run the expiry job:

```bash
# end the trial now
npx dotenv -e .env.dev -- node -e 'const{MongoClient}=require("mongodb");(async()=>{const c=await MongoClient.connect(process.env.MONGODB_URI);const r=await c.db().collection("tenants").updateOne({slug:process.argv[1]},{$set:{"billing.trialEndsAt":new Date(Date.now()-60000)}});console.log("trial ended:",r.modifiedCount);await c.close()})()' my-shop

# the same job production will run on a schedule
npx dotenv -e .env.dev -- tsx scripts/expire-trials.ts
```

Reload `/account`: the badge says **Free** and the upgrade card appears.
(Alternatively use a seeded Free tenant, e.g. `owner@bellas-barbershop.test` /
`Dev!12345678`.)

To see billing state at any point:

```bash
npx dotenv -e .env.dev -- node -e 'const{MongoClient}=require("mongodb");(async()=>{const c=await MongoClient.connect(process.env.MONGODB_URI);const t=await c.db().collection("tenants").findOne({slug:process.argv[1]},{projection:{_id:0,slug:1,tier:1,readOnly:1,billing:1}});console.log(JSON.stringify(t,null,1));await c.close()})()' my-shop
```

**4. Subscribe.** `/account` → pick Monthly or Annual → *Upgrade to Premium* →
Stripe Checkout → card `4242 4242 4242 4242`, any future expiry, any CVC, any
name/postcode → you land on `/billing/success`.

Expect:
- `stripe listen` shows `checkout.session.completed` `[200]` (plus
  `customer.subscription.created`, `invoice.paid`, … — accepted and ignored).
- Billing state: `tier: "premium"`, `billing.stripeCustomerId: "cus_…"`,
  `billing.stripeSubscriptionId: "sub_…"`.
- `/account` shows **Premium** after a reload (the success page deliberately
  doesn't poll), and Premium-only controls unlock without logging out.
- Stripe dashboard (test mode) → Customers: a customer with metadata
  `tenantId`, and an active subscription.

Steps 5–8 use `$STRIPE_KEY` — set it in the terminal you run them from
(`STRIPE_KEY=$(grep '^STRIPE_SECRET_KEY=' .env.dev | cut -d= -f2-)`).

**5. Webhooks are idempotent.** Copy the `evt_…` id of the
`checkout.session.completed` line from the `stripe listen` output, then:

```bash
stripe events resend evt_... --api-key "$STRIPE_KEY"
```

It is answered `[200]` and changes nothing — the id is already in the
`billing_webhook_events` collection, so the handler returns before acting.

**6. Failed payment → grace period.** The `0341` test card can't do this
through Checkout (Checkout declines it up front and no subscription is
created). Charge the existing customer instead, with a card that attaches but
fails:

```bash
CUS=cus_...   # from the billing state
PM=$(stripe payment_methods attach pm_card_chargeCustomerFail --customer $CUS --api-key "$STRIPE_KEY" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
stripe customers update $CUS -d "invoice_settings[default_payment_method]=$PM" --api-key "$STRIPE_KEY"
stripe invoiceitems create --customer $CUS --amount 500 --currency eur --api-key "$STRIPE_KEY"
INV=$(stripe invoices create --customer $CUS -d pending_invoice_items_behavior=include --api-key "$STRIPE_KEY" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
stripe invoices pay $INV --api-key "$STRIPE_KEY"   # fails — that's the point
```

Expect `invoice.payment_failed` `[200]`; the tenant is **still Premium** with
`billing.graceExpiresAt` 7 days out. Nothing is frozen or unpublished yet.

**7. Grace expires → downgrade.** Nothing runs this on a schedule yet. Move
the deadline into the past and run the expiry function by hand:

```bash
npx dotenv -e .env.dev -- node -e 'const{MongoClient}=require("mongodb");(async()=>{const c=await MongoClient.connect(process.env.MONGODB_URI);const r=await c.db().collection("tenants").updateOne({slug:process.argv[1]},{$set:{"billing.graceExpiresAt":new Date(Date.now()-60000)}});console.log("grace ended:",r.modifiedCount);await c.close()})()' my-shop
npx dotenv -e .env.dev -- npx tsx -e 'import("./src/server/services/billing").then((m) => m.expireDueGracePeriods()).then((n) => { console.log("grace periods expired:", n); process.exit(0); })'
```

Expect `tier: "free"`, public forms beyond 2 unpublished (oldest kept), and
`readOnly` listing `entities`/`records` if the tenant is over the Free limits —
nothing deleted. Note this downgrades Graft's side only; the Stripe
subscription is still active (cancel it in step 8 to keep the two in step).

**8. Cancellation → downgrade.** Upgrade again first if step 7 left you on
Free (the upgrade button is back; it reuses the same Stripe customer). Then
cancel **immediately** — "at period end" only schedules it, and Graft
downgrades on `customer.subscription.deleted`, which then won't arrive until
the period ends:

```bash
SUB=sub_...   # from the billing state
stripe subscriptions cancel $SUB --api-key "$STRIPE_KEY"
```

(or Dashboard → the subscription → *Cancel subscription* → *Immediately*).
Expect `customer.subscription.deleted` `[200]`, then the same Free downgrade as
step 7: data kept, over-limit resources read-only, excess forms unpublished.

## Known gaps (not bugs in the runbook — things the product doesn't do yet)

- No Stripe customer portal: owners can't update a card or cancel from Graft.
- A grace period is only cleared by the subscription going back to `active`
  (`customer.subscription.updated`). Recovering from a failed *renewal* needs
  a real renewal to fail and then succeed — Stripe test clocks, which the
  checkout flow doesn't create customers on — so it isn't in this runbook.
- Trial expiry and grace-period expiry need a scheduler (`docs/GO-LIVE.md` §4);
  grace expiry has no runnable script, only the function called in step 7.
- A subscription cancelled "at period end" stays Premium in Graft until Stripe
  sends `customer.subscription.deleted` at the period end — correct, but it
  can't be tested quickly without Stripe test clocks, which checkout doesn't
  create customers on.
- The success page doesn't wait for the webhook; a reload of `/account` is
  what shows the new plan.
- QA (`.env.qa`) still has dummy Stripe values; repeating steps 1–2 against
  `.env.qa` and `localhost:3100` makes it testable there too.
