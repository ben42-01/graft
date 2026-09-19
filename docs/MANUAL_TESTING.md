# Graft — Manual Test Session Guide

Ad-hoc, human-run walkthrough for exercising a dev or QA build by hand. Not a
replacement for `npm run verify` / Bruno / e2e — use this when you want to
*feel* the product, especially the two Stripe paths, which nothing automated
touches end-to-end.

---

## 0. Pick your stack

| | dev | QA |
|---|---|---|
| App | `npm run dev:full` (or `npm run dev` if db/seed already up) | `npm run qa:full` |
| URL | http://localhost:3000 | http://localhost:3100 |
| Reset data | `npm run dev:reset` | `npm run qa:db:down && npm run qa:full` (fresh seed every run — [[qa-stack-wedges-verify-full]]) |
| Stripe billing keys | **real test-mode keys** already in `.env.dev` (see §2) | dummy placeholders only — checkout redirect won't work |
| Seeded users | `scripts/seed-dev.ts` | `scripts/seed-qa.ts`, fixed users below |

QA seeded logins (password `qa-fixture-password-2026` for all — from `scripts/seed-qa.ts`):

- `owner@qa-free.test` — Free tier owner
- `owner@qa-premium.test` — Premium tier owner
- `member@qa-premium.test` — Premium tier, member role
- `owner@qa-at-quota.test` — Free tier, at quota (good for limit/upgrade-prompt testing)
- `owner@qa-downgraded.test` — post-downgrade state (read-only overflow)
- `both@qa.test` — member on one tenant, admin on another (role-switching)
- `unverified@qa.test` — unverified email (tests the verify-email gate)

For onboarding/entity/resource work below, **dev with a fresh signup** exercises the real first-run path best; the QA users already have entities seeded, which is better for "does the workspace behave once it's populated" testing.

---

## 1. Onboarding → entity → resource → general workspace

This is the `src/app/(app)/onboarding/page.tsx` wizard: profile → template →
plugins → guided entity → guided form → dashboard hand-off. Every step calls
the same `/api/v1/entities`, `/api/v1/forms`, `/api/v1/plugins/*`,
`/api/v1/dashboards` endpoints a hand-built flow would, so there's no
wizard-only path to miss.

1. **Sign up fresh** (dev) — new email, through the real signup form, verify email link.
2. **Onboarding wizard**
   - Business profile: name, industry, size, region, currency, timezone.
   - Template: pick an industry template or start blank (`BLANK_TEMPLATE`) — try both across two signups if time allows, template pre-fills entity fields and is worth checking separately from blank.
   - Plugins: enable a couple, confirm they show up gated correctly afterward.
   - Guided entity: create the first entity (this is your "resource" — e.g. a bookable Room/Service/Staff entity). Confirm fields match what the template suggested, or hand-add fields on blank.
   - Guided form: build the public form bound to that entity.
   - Dashboard hand-off → confirm it lands you in the real workspace, not a wizard-only shell.
3. **Post-onboarding, in the normal workspace** (`/entities`, `/entities/[entityId]`):
   - Add/edit/delete records under the entity by hand.
   - Add a second entity manually (not through onboarding) via Entity Builder — confirm field types, required flags, templates gallery (`/entities/templates`) all work outside the wizard.
   - Check `/operations`, `/dashboards/[dashboardId]`, `/plugins`, `/guide`, `/home` render sensibly with real data now in the tenant.
4. **Public form path**: open the public form URL (`graft.app/f/{tenantSlug}/{formSlug}` shape — check the actual slug in the form builder), submit as an anonymous visitor, confirm a record + submission land back in the entity, and check the Open Graph card / carousel if the form has photos.

Known gaps to expect, not bugs (per [[ui-surface-gaps]]): some working endpoints (forms builder edge cases, plugin management, members) may still be thin on UI — note anything that looks like a genuine regression vs. a known gap.

### 1A. Business templates (`/templates`)

One click builds a whole workspace; this is the fastest path to a working
public booking page. Apply on a **fresh** tenant for the Free-plan checks —
a seeded tenant has already spent some of its allowance.

1. `/templates` lists ten cards. Open **Graft Hotel**.
2. **How you work** — toggle "book dates online" and "rooms vs room types"; on Free, tick *Guest book* and confirm *Housekeeping* becomes locked ("More than your plan has room for").
3. **Names & details** — rename Room → Cabin; untick *Description*. Confirm it disappears from the list's field chips.
4. **Money & terms** — deposit 25, paste a `https://buy.stripe.com/test_…` link (a non-Stripe URL must be refused inline), add a terms URL.
5. **Review** — the plan table shows what it uses against what's left; the form card says "Takes bookings … 25% deposit", "Stripe payment link", "must agree to your terms".
6. Apply → **Done** screen. Open the public page:
   - pick a cabin, dates, tick "I agree to the house rules", submit → you are offered the Stripe link with `client_reference_id`;
   - `/operations`: a draft order at nights × price with a 25% deposit;
   - submit an overlapping stay for the same cabin → refused as unavailable.
7. Apply **Graft Trades** with defaults → a quote form with the service catalogue and **no** booking; no pools created.
8. Apply Graft Hotel a second time on a premium tenant → the review notes the new names (`rooms_2`, `book-a-room-2`); nothing of the first is touched.
9. Delete the Rooms entity from `/entities`, then apply again → it is recreated as `rooms` (needs migration 003 on that database).

---

## 2. Stripe — two separate things, don't cross the streams

Graft touches Stripe in two completely unrelated ways. Test them separately
and don't reuse credentials/products between them.

### 2A. Graft's own Premium subscription billing

This is Graft-as-a-business charging *tenants* for the Premium tier
(`docs/TIERS.md` §3, `src/server/services/billing.ts`, checkout route,
webhook route). Already partly set up per `docs/STRIPE.md` — a dedicated
**"Graft" Stripe account** (not a sandbox of another account) exists in test
mode with the product catalog already created:

| | id |
|---|---|
| Product "Graft Premium" | `prod_V77uHDhlwYEXYh` |
| Price "Premium Monthly" (€29/mo) | `price_1U6teV74G5LPLMfkPmhx7aJ2` |
| Price "Premium Annual" (€290/yr) | `price_1U6teV74G5LPLMfkS069E7c7` |

`.env.dev` has the real secret key and price IDs; the webhook secret is still
the fixture placeholder. **Follow the runbook in `docs/STRIPE.md`** — it was
checked against the code and covers, in order:

1. Getting the `whsec_…` with `stripe listen --api-key … --print-secret` (once), then keeping `stripe listen --forward-to localhost:3000/api/v1/webhooks/stripe` running.
2. Getting a tenant onto **Free** first — every new sign-up starts on a 14-day Premium trial, and the upgrade button only shows on Free.
3. Subscribing through `/account` with `4242 4242 4242 4242` and checking the webhook flips the tenant to Premium.
4. Webhook idempotency (`stripe events resend`).
5. A failed payment → 7-day grace period (charged against the existing customer — the `0341` card is declined by Checkout itself, so it can't be used there).
6. Grace expiry and cancellation (must be *immediately*) → downgrade to Free with nothing deleted.

QA currently has only dummy Stripe values (`sk_test_local_dummy_key`, fixture webhook secret) — checkout redirect won't actually work there. If you want this testable on QA too, that's a repeat of the same setup against `.env.qa` and a `stripe listen --forward-to localhost:3100/...`, sharing the same "Graft" Stripe test account/products (test mode is safe to reuse across environments — it's not real money either way).

### 2B. Tenant payment links on public forms

Completely separate: this is a *business* (tenant) collecting money from
*their own* customer via a Stripe Payment Link pasted into the form builder
(`src/components/forms/payment-editor.tsx`, `src/lib/payment-links.ts`).
Graft never sees a key here — it only validates the URL is `https://buy.stripe.com/...`
and redirects the submitter. No webhook, no reconciliation — the business
confirms payment manually on the orders board.

To test this you need a payment link from *some* Stripe test-mode account —
doesn't have to be the "Graft" account above; a personal/other test account
works fine since Graft never touches its keys. Steps to create one:

1. Log into any Stripe account, switch to **test mode** (toggle top-right).
2. **Product catalog → + Add product.** Create something generic, e.g.:
   - Name: "Graft Test Booking Fee"
   - Price: one-time, e.g. €25.00 (or recurring if you want to test that too — Payment Links support both)
3. Save the product, then on the product page click **Create payment link**.
   - Leave "After payment" as the default confirmation page (Graft doesn't use Stripe's own redirect for this flow).
4. Copy the resulting `https://buy.stripe.com/test_...` URL.
5. In Graft, open a form in the Form Builder, enable **Payment** in the Payment panel, paste the link, choose whether it's required (redirect immediately) or optional (offered on the thank-you page), save.
6. Submit the form as a visitor:
   - Confirm the record/submission is created **regardless** of what happens next (submission is never conditional on payment).
   - If "required" is on: confirm you land on the Stripe test payment page immediately, with `client_reference_id` set on the URL to the order/submission id (view it in the address bar or Stripe's payment details after paying).
   - Pay with `4242 4242 4242 4242` (any future expiry/CVC).
   - Back in Graft, confirm the order sits in **Awaiting payment** on the orders board (link mode never auto-confirms) and manually mark it paid — confirm that's a real, distinct action.
7. Negative cases worth trying in the form builder itself:
   - Paste a non-Stripe URL, or `https://buy.stripe.com.evil.test/x` — should be rejected inline (`isPaymentLinkUrl`), not just on save.
   - Paste a protocol-relative `//buy.stripe.com/x` — should also be rejected (no scheme inherited).

---

## 3. Graft Admin (platform owner)

Shipped by GRAFT-27 (issues #85–#88): a platform-admin actor distinct from
any tenant role, its own gate, a cross-tenant read API, an `/admin` console,
and one audited mutation (manual tier override). `roles` on a membership are
still tenant-scoped (`owner` / `admin` / `member`) exactly as before — the
platform flag is a separate boolean on the `users` document
(`isPlatformAdmin`), re-read from the database on every admin request, never
trusted from the access token.

**Sign in as the platform admin** (dev or QA — dev needs
`scripts/grant-platform-admin.ts <email>` run once against a real user first;
QA seeds it for you):

- QA: `platform-admin@qa.test` / `qa-fixture-password-2026`. This user
  happens to belong to tenant `qa-platform`, but tenant membership grants
  nothing here — the flag is what matters.
- For the negative case: `owner@qa-platform.test` holds tenant `owner` **and**
  `admin` roles but no platform flag — confirms the tenant `admin` role does
  not leak into platform-admin access.

**Walkthrough:**

1. Sign in as `platform-admin@qa.test`, then visit `/admin` directly — there
   is no nav link into it from the tenant app by design (typing the URL is
   the only way in). You land on `/admin/tenants`, a table of every tenant in
   the system (not just ones you belong to): name, slug, tier, freeze
   indicator, trial/grace state.
2. Try the search box (`?q=`) and the tier filter — both re-query the server,
   not a client-side filter of one page. Page through if there are enough
   tenants to trigger the cursor pager.
3. Open a tenant with billing history, e.g. `qa-downgraded` — the detail
   screen shows resolved limits, which limit keys are overridden, the
   read-only freeze list, `downgradedAt`, billing anchor day, and trial/grace
   dates. Confirm no Stripe customer/subscription id or any email appears
   anywhere on the screen — the API only ever reports booleans
   (`hasCustomer` / `hasSubscription`).
4. **Tier override** (the one mutation): open `qa-override` (Premium, with a
   fake Stripe customer/subscription attached) and use the tier-override
   control. It requires a typed reason and an explicit confirm step that
   names the tenant and states Stripe billing is not touched by the flip.
   Flip it to Free and confirm: over-limit meters go read-only, its overflow
   public forms get unpublished (oldest kept), and nothing is deleted — the
   tenant's records are all still there, just frozen. Flip it back to Premium
   on `qa-override-upgrade` and confirm the freeze clears and limits restore.
   Every call — read or write — appends one row to `admin_audit_log`; there
   is no UI for that log yet (it's `admin_audit_log`, a separate collection
   from the customer-facing activity log below), so check it via `mongosh` if
   you want to see the audit trail directly.
5. **Activity log** (GRAFT-29): from a tenant's detail screen, click "View
   activity" — lands on `/admin/activities?tenantId=<id>`, pre-filtered and
   locked to that tenant (the filter can't be cleared from this screen; go to
   `/admin/activities` directly for the cross-tenant view). Try the action
   dropdown — exactly the five families (`notify.email`, `billing.subscription`,
   `billing.payment`, `account`, `entity`) plus "All", never free text — the
   actor-type filter, the date range, and search; each re-queries the server.
   Expand a row to see its full context with human labels rather than raw
   JSON; a `notify.email` row shows its template and masked recipient plus
   the row's own succeeded/failed outcome. Page through with "Load more" if
   there's enough activity to trigger the cursor pager.
6. **Prove the boundary, not just the happy path:** sign out, sign in as an
   ordinary tenant owner (e.g. `owner@qa-premium.test`), and visit `/admin`
   or `/admin/tenants` directly. You should be bounced to `/` with **no**
   flash of tenant data, no "you're not an admin" message, nothing — the
   admin surface returns `404`, not `403`, specifically so it doesn't confirm
   its own existence to a non-admin. Same test with no session at all should
   redirect to `/login?redirect=...` and land you back on the console after
   signing in.

**Deliberately not built (v1 scope decision, see issue #84):**

- **Impersonation / "log in as tenant"** — highest blast-radius feature on
  the list, needs its own audit/consent/token design before it's worth
  building.
- **Editing `tenants.limits` override keys by hand** — an Enterprise-deal
  tool, not a support tool; the tier override re-materialises limits from the
  tier constant instead.
- **A Stripe webhook failure / dead-letter view** — there's no data to show
  yet; a failed webhook delivery today writes nothing at all, so this needs
  the webhook path changed first (its own contract, `src/app/api/v1/webhooks/stripe/**`
  is protected).
- Member/user administration, tenant suspension or deletion, cross-tenant
  record/submission access, usage analytics.

For support cases needing Stripe's own event history (not Graft's stored
view of billing), the Stripe dashboard is still required — the console shows
what Graft believes, not what Stripe has done.
