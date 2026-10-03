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

### Per-order payment links (cart forms)

A form where the customer picks several items has no fixed price, so it takes
no payment when submitted. The order it raises is priced; the tenant makes a
Payment Link or a one-off invoice for that amount in their own Stripe
dashboard and attaches it to the order (`PUT /api/v1/orders/:id/payment-link`,
the *Payment link* section of the order page). Only `https://buy.stripe.com/…`
and `https://invoice.stripe.com/…` are accepted (`isOrderPaymentUrl`); a
Payment Link gets the order id as `client_reference_id`. The order page
offers *Email customer* (opens the tenant's own mail app — Graft sends no
email yet) and *Copy message*. Payment is still recorded by hand.

## Connect Checkout — retired from new forms (2026-10-03)

Connect Checkout made Graft create and onboard a **new** Stripe account for
every tenant (there is no way to attach an account they already have without
OAuth), and Stripe's hosted onboarding was too much to ask. The form builder
now only offers it on a form that already uses it; everything below — the
service, the webhook, the stored account ids — is left in place and still
works for those forms. Payment links above are the default.

## Connect Checkout: itemised vs single-line sessions

When a form uses Checkout mode (`src/server/services/stripe-connect.ts`,
`checkoutLines`), the session Graft opens on the tenant's connected account
shows the customer:

- **Itemised** — one Stripe line per order line (name, quantity, unit price)
  when the whole order is charged at once: no deposit, nothing paid yet. A
  line whose `unitAmountMinor × quantity` doesn't reproduce its `amountMinor`
  (duration-priced hire) goes as quantity 1 at its amount.
- **One line** for the amount due otherwise: `Deposit — <form name>` for a
  deposit, `Balance — <form name>` after any partial payment, and
  `Order — <form name>` when the order has more than Stripe's 100-line limit or
  its lines can't be sent as they are (a discount line — Stripe takes no
  negative lines).

Whatever the shape, the session total always equals the amount due on the
order; the Connect webhook records the payment against the order id either way.

## Connect Checkout: who configures what

Checkout mode on a form (PR #113) is the one place a tenant's payments touch
Graft's Stripe account, through **Stripe Connect**. The split of
responsibility:

| | Who | What |
|---|---|---|
| Tenant | the customer | Clicks *Connect Stripe* in the form's payment settings and completes Stripe's own onboarding for **their** Stripe account. Picks the business country first — it is fixed when the account is created. Never sees, enters or needs any key or webhook. Graft stores only the account id (`tenants.stripeConnect.accountId`). |
| Platform | **us, once per deployment** | Enables Connect on the Graft Stripe account, registers one webhook endpoint, and sets `STRIPE_CONNECT_WEBHOOK_SECRET`. |

`STRIPE_CONNECT_WEBHOOK_SECRET` is **not per tenant.** It is the signing secret
of a single "events from connected accounts" endpoint that we register in
*our* dashboard. All tenants share it; a new tenant needs nothing from us.
Each event carries `event.account`, and `/api/v1/webhooks/stripe-connect` only
marks an order paid when that account matches the tenant's stored
`stripeConnect.accountId` — events for unknown accounts are ignored, so one
tenant can't pay another's orders. The route is deliberately separate from the
Premium billing webhook (`/api/v1/webhooks/stripe`, `STRIPE_WEBHOOK_SECRET`).

Why a webhook at all: the Checkout session and payment live in the tenant's
Stripe account, so Stripe has to tell Graft when an order was paid.

### Accounts v2

Connected accounts are created with **Accounts v2** (`POST /v2/core/accounts`)
— Stripe refuses v1 `accounts.create` for new Connect platforms. The request
(`realConnectStripeClient` in `src/server/services/stripe-connect.ts`) is
`dashboard: "full"`, `defaults.responsibilities` `fees_collector: "stripe"` +
`losses_collector: "stripe"`, and the merchant configuration with
`card_payments` requested. That is what v1 called a **Standard** account (v1
`accounts.retrieve` reports it as `type: "standard"`): the tenant owns it, has
the full dashboard, and carries its own fees, refunds and disputes.
Checked against test mode on 2026-10-03 (stripe-node 23, API `2026-09-30.endive`).

- **Country is required and permanent.** The merchant configuration can't be
  added without `identity.country`, so the payment editor asks for it (default
  Ireland, the platform's country). The list, `src/lib/stripe-connect-countries.ts`,
  is Stripe's `country_specs` for this platform minus India (no card payments
  on this account type). A wrong choice means *Use a different Stripe account*.
- **Readiness** has no `charges_enabled` in v2. Graft reads
  `configuration.merchant.capabilities.card_payments.status === "active"`, and
  "details submitted" as no requirement awaiting the user that is
  `currently_due` or `past_due`.
- **Onboarding link** is `POST /v2/core/account_links` with
  `use_case.type: "account_onboarding"`.
- **Webhook unchanged.** A v2 account with the merchant configuration still
  sends the v1 `account.updated` snapshot in the *Connected accounts* scope, so
  the existing endpoint keeps working. Thin `v2.core.account[...]` events
  would need a separate *Your account* event destination; Graft doesn't use them.
- **Checkout unchanged.** v2 account ids are still `acct_…`, and direct-charge
  Checkout Sessions use the same `Stripe-Account` header.
- **The "Accounts v1 support" dashboard switch** (enabled on the test account
  as a stopgap on 2026-10-03) should no longer be needed. Nothing in Graft
  creates through v1 any more, but this was only tested with the switch still
  on — turn it off, re-run *Connect Stripe* once, and don't enable it on
  QA/production accounts.

**Symptom of it missing:** onboarding fails with `500 "Card payments are not
configured"` and the log shows `connect.env.invalid` with
`missing: ["STRIPE_CONNECT_WEBHOOK_SECRET"]`. The env is validated as a whole,
so this blocks onboarding even though onboarding itself doesn't use the secret.
Premium billing keeps working, because it reads a different set of variables.

### Where the secret comes from

There is no secret to look up in advance: **you create the endpoint (or run the
CLI), and Stripe then shows you its `whsec_…`.** Two sources, depending on
where the server runs:

| Server runs… | Source of the secret | Needs a public URL? |
|---|---|---|
| On your machine (dev, local QA) | The Stripe CLI: `stripe listen --print-secret` | No — the CLI forwards events to localhost |
| Deployed (production, a hosted QA) | A webhook endpoint you add in the Stripe dashboard | Yes — Stripe must reach the URL |

Each environment and each Stripe mode (test / live) has its **own** secret.
Never reuse one across them: a secret from the wrong endpoint makes every event
fail with `400 Invalid signature`.

### Dev (your machine, test mode)

1. Enable Connect: Stripe dashboard (test mode, the Graft account) →
   **Connect** → *Get started*. Once per Stripe account.
2. Get the secret:

   ```bash
   STRIPE_KEY=$(grep '^STRIPE_SECRET_KEY=' .env.dev | cut -d= -f2-)
   stripe listen --api-key "$STRIPE_KEY" --print-secret
   ```

   It prints `whsec_…` and exits. It is stable for this key on this machine.

   **This is the same value as `STRIPE_WEBHOOK_SECRET`** (Premium billing):
   the CLI signs everything it forwards — to `/webhooks/stripe` and to
   `/webhooks/stripe-connect` — with one secret per key. Locally, paste it into
   both variables. In a deployed environment the two are separate dashboard
   endpoints with **different** secrets; never reuse one for the other there.
3. Put it in `.env.dev`:

   ```
   STRIPE_CONNECT_WEBHOOK_SECRET=whsec_…
   ```
4. Restart `npm run dev` (env is read once and cached).
5. Every test session, in its own terminal, leave this running:

   ```bash
   stripe listen --api-key "$STRIPE_KEY" \
     --forward-connect-to localhost:3000/api/v1/webhooks/stripe-connect
   ```

   Each event should print `[200]`. `[400]` = wrong secret in `.env.dev` (redo
   step 2–4). No events at all = the forwarder isn't running; a payment can
   then succeed in Stripe while the order stays unpaid in Graft.
6. Run `npm run db:indexes` once.

### QA (local stack, test mode)

Same as dev, against `.env.qa` and the QA port (`localhost:3100`):

1. `STRIPE_KEY=$(grep '^STRIPE_SECRET_KEY=' .env.qa | cut -d= -f2-)` — QA
   currently has a dummy key (see Known gaps), so first put a real test-mode
   `sk_test_…` there.
2. `stripe listen --api-key "$STRIPE_KEY" --print-secret` → 
   `STRIPE_CONNECT_WEBHOOK_SECRET` in `.env.qa`.
3. Restart the QA stack; forward with
   `--forward-connect-to localhost:3100/api/v1/webhooks/stripe-connect`.

If QA is instead deployed somewhere reachable, treat it like production below,
using **test mode** in the dashboard.

### Production (deployed, live mode)

1. Stripe dashboard, switched to **live mode** → **Connect** → *Get started*
   (live mode needs the platform profile completed; test mode doesn't).
2. **Developers → Webhooks → Add endpoint.**
3. Under *Listen to*, choose **Events from connected accounts** — not "Events
   from your account". This is the setting that delivers every customer's
   events to this one endpoint.
4. Endpoint URL: `https://<your-domain>/api/v1/webhooks/stripe-connect`.
5. Select events: `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`, `account.updated`.
6. Click *Add endpoint*. On the endpoint's page, under **Signing secret**,
   click *Reveal* and copy the `whsec_…`.
7. Set it as `STRIPE_CONNECT_WEBHOOK_SECRET` in the production environment
   (alongside the live `STRIPE_SECRET_KEY`) and redeploy/restart.
8. Run `npm run db:indexes` against the production database once.
9. Check: the endpoint page in Stripe shows delivery attempts; after a test
   purchase on a connected account they should be `200`. Failed deliveries
   can be resent from there.

A hosted test-mode QA is the same eight steps with the dashboard in **test
mode** and the QA domain/secret.

### Checklist

| | Dev | QA | Prod |
|---|---|---|---|
| Stripe mode | test | test | live |
| Connect enabled | ✔ | ✔ | ✔ |
| Secret from | CLI | CLI (or test-mode endpoint) | dashboard endpoint |
| Forwarder running | yes | yes | no — Stripe calls the URL |
| `db:indexes` | once | once | once |

Checkout mode only works on booking forms: the amount charged is the order's
amount due (deposit, else total).

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
  pricing at the time (€29/mo, €290/yr — superseded, see "Changing prices"):

  | | id |
  |---|---|
  | Product "Graft Premium" | `prod_V77uHDhlwYEXYh` |
  | Price "Premium Monthly" (€29.00/mo, EUR) | `price_1U6teV74G5LPLMfkPmhx7aJ2` |
  | Price "Premium Annual" (€290.00/yr, EUR) | `price_1U6teV74G5LPLMfkS069E7c7` |

  These map directly to `STRIPE_PRICE_PREMIUM_MONTHLY` /
  `STRIPE_PRICE_PREMIUM_ANNUAL` in `src/server/services/billing.ts`'s
  `billingEnvSchema`.

## Changing prices

The app never sends Stripe an amount — Checkout gets a price **ID** and Stripe
bills whatever that price says. The figures on the landing and account pages
come from `src/lib/pricing/pricing.json` (minor units; the annual amount is
stored exactly, and the "2 months free" / "Save N%" label is derived from it).
The two must agree, so a price change is:

1. In Stripe (each account/mode: test for dev + QA, live for production),
   create new prices on "Graft Premium" — Stripe prices can't be edited.
   Optionally archive the old ones so they can't be reused by mistake.
2. Set `STRIPE_PRICE_PREMIUM_MONTHLY` / `_ANNUAL` to the new IDs in every
   environment's env.
3. Edit `pricing.json` to the same amounts and deploy.
4. Existing subscribers stay on their old price until migrated in Stripe
   (Subscription → Update → change price); new Checkouts get the new one.

Current target (2026-09-28): **€19.00/month, €190.00/year** (was €29/€290).

## Checked against the code (2026-09-18)

| | State |
|---|---|
| `STRIPE_SECRET_KEY` in `.env.dev` | ✅ real `sk_test_…`. Stripe reports the account as **"Graft sandbox"** (`acct_1U6tbx74G5LPLMfk`) — confirm in the dashboard that this is the standalone "Graft" account described above and not a sandbox nested under another business. |
| `STRIPE_PRICE_PREMIUM_MONTHLY` / `_ANNUAL` | ⚠️ both active in that account, test mode, but still €29.00/month, €290.00/year — replace with €19/€190 prices (see "Changing prices") |
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
