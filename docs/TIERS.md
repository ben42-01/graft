# Graft — Subscription Tiers Specification

**Doc:** GRAFT-DOC-02 · Companion to `README.md`
**Status:** Draft for review

---

## 1. Pricing Philosophy

Graft monetizes on two axes:

1. **Usage limits** — primarily **Form usage** (forms created + monthly submissions), since Customer Forms are the growth engine and the most visible value.
2. **Capability gating** — power features (Batch CSV Upload, External Tenant Connectors, Automations, API access) are Premium/Enterprise only.

The Free tier must be genuinely useful (a solo business can run on it), but growth naturally pushes tenants into limits: more forms, more submissions, more data, more integrations.

---

## 2. Tier Matrix

### 2.1 Core Limits

| Limit | Free | Premium | Enterprise |
|---|---|---|---|
| Users / seats | 1 | 15 (add-on seats available) | Unlimited |
| Plugins enabled | 3 core | All standard | All + custom plugins |
| Custom entities | 3 | 25 | Unlimited |
| Records per tenant | 2,000 | 100,000 | Unlimited (fair use) |
| File storage | 250 MB | 20 GB | 1 TB+ (negotiable) |
| Dashboards | 1 | 10 | Unlimited |

### 2.2 Form Usage (primary metering axis)

| Limit | Free | Premium | Enterprise |
|---|---|---|---|
| Active Customer Forms | 2 | 20 | Unlimited |
| Submissions / month | 100 | 5,000 | Unlimited (fair use) |
| Internal forms | 3 | Unlimited | Unlimited |
| File upload fields on forms | — | ✓ (10 MB/file) | ✓ (100 MB/file) |
| Conditional logic / multi-step forms | — | ✓ | ✓ |
| Form analytics (views, conversion) | — | ✓ | ✓ Advanced |
| "Powered by Graft" badge | Required | Removable | White-label |
| Custom form domain | — | — | ✓ |
| Submission overage | Hard stop + upgrade prompt | €X per additional 1,000 | N/A |

**Metering rules:**
- A submission counts when a public form POST is accepted (spam-rejected submissions don't count).
- Counters reset on the tenant's billing anniversary.
- Soft warning at 80% usage (email + in-app banner); hard behavior at 100% per tier above.

### 2.3 Data & Integration Features

| Feature | Free | Premium | Enterprise |
|---|---|---|---|
| Manual record CRUD | ✓ | ✓ | ✓ |
| CSV export | ✓ | ✓ | ✓ |
| **Batch CSV Data Upload** (import wizard, field mapping, dedupe, dry-run preview) | — | ✓ 10k rows/import | ✓ Unlimited |
| **External Tenant Connectors** (sync existing data via REST: scheduled pulls, webhook pushes, field mapping) | — | ✓ 2 connectors, hourly sync | ✓ Unlimited connectors, near-real-time |
| Inbound webhooks | — | ✓ | ✓ |
| Outbound webhooks | — | ✓ 5 endpoints | ✓ Unlimited |
| Public REST API access | — | Read-only, rate-limited | Full read/write, elevated limits |
| Zapier/Make-style integration | — | ✓ | ✓ |

### 2.4 Platform & Workflow Features

| Feature | Free | Premium | Enterprise |
|---|---|---|---|
| Automations (trigger → action) | — | 20 active rules | Unlimited + advanced (branching, delays) |
| Team roles & permissions | — | Standard roles | Custom roles, per-plugin scopes |
| Audit log | — | 90-day retention | Unlimited + export |
| Scheduling plugin | Basic calendar | Full (reminders, availability) | Full + resource scheduling |
| Invoicing plugin | — | ✓ | ✓ + custom templates |
| Reports plugin | — | ✓ | ✓ + scheduled report emails |
| Email notifications | Graft-branded | Custom sender name | Custom SMTP/domain (DKIM) |

### 2.5 Enterprise-only

- SSO (SAML / OIDC), SCIM provisioning
- White-labeling + custom app domain
- Dedicated MongoDB cluster option / data residency (EU pinning)
- SLA (99.9%), dedicated support contact, onboarding assistance
- Custom plugin development / Plugin SDK access
- Contractual DPAs, security questionnaires, invoiced billing

---

## 3. Pricing (proposed, to validate)

| | Free | Premium | Enterprise |
|---|---|---|---|
| Monthly | €0 | €29 / mo per tenant (incl. 5 seats) + €5/extra seat | Custom (from €299/mo) |
| Annual | €0 | €290 / yr (2 months free) | Custom |
| Add-ons | — | +1,000 submissions €5; +10 GB storage €3 | Included / negotiated |

Regional pricing and VAT handling via Stripe Tax. 14-day Premium trial on sign-up (no card required); trial expiry downgrades gracefully to Free (data retained, features locked, over-limit resources set read-only — never deleted).

---

## 4. Enforcement Architecture

- **Single source of truth:** `tenants.tier` + `tenants.limits` (materialized limit object, overridable per-tenant for Enterprise deals).
- **Entitlement service:** `can(tenantId, feature)` and `checkQuota(tenantId, meter, amount)` called in the API service layer — never in the client. UI reads the same entitlement object to hide/disable gated features with upgrade prompts.
  Enforced call sites so far: `csv_import` on batch record import
  (`src/server/services/imports.ts`, GRAFT-25.1) — a Free tenant gets
  `403 FEATURE_NOT_AVAILABLE` naming the feature, Premium is capped at 10,000
  rows per import, and Enterprise's `records: null` is read as *unlimited* and
  branched on rather than coalesced to 0.
- **Meters collection:** `usage_meters { tenantId, meter, period, count }` with atomic `$inc`; evaluated on every metered write.
- **Stripe webhooks** (`checkout.session.completed`, `customer.subscription.updated/deleted`) update tier; grace period of 7 days on failed payment before downgrade.
- **Downgrade policy:** nothing is deleted. Over-limit forms are unpublished (owner picks which stay active), over-limit entities/records become read-only, connectors pause.
- **Trial:** the 14-day Premium trial (§3) is granted at sign-up (`accounts.ts`, no card, no Stripe). A lapsed trial expires by the identical path as a cancellation — `expireTrial()` → `applyDowngradePolicy()` — so trial-end and cancellation share one downgrade mechanism.
- **Manual override — the second write path to `tenants.tier`** (GRAFT-27.4).
  Stripe webhooks are no longer the only thing that moves a tenant's tier. A
  platform admin can flip it directly through
  `POST /api/v1/admin/tenants/:tenantId/tier`, for the cases where Stripe and
  Graft have disagreed: a webhook that never landed, a refund, a comped
  account, a failed trial conversion. What matters about it:
  - **It is not a `tenants.tier` write.** The endpoint is a thin, audited
    caller of the same two functions the webhooks use —
    `applyUpgrade()` on the way up, `applyDowngradePolicy()` on the way down —
    so an override produces exactly the state a Stripe event would, freeze and
    unpublish included. A hand-written tier edit (what a Mongo shell does)
    skips all of that and leaves the tenant in a state no code path produces.
    `src/server/services/admin-tier.ts` contains no transition policy of its
    own and must not gain any.
  - **It does not touch Stripe.** No subscription is created, cancelled or
    refunded. A tenant with a live subscription can be put on `free` here and
    Stripe will keep billing them until someone changes it in Stripe. This is
    accepted v1 behaviour, and the confirm dialog says so before the operator
    commits.
  - **Every call is audited.** A free-text `reason` (1–500 chars) is required —
    an unaudited tier flip is not a supported operation — and exactly one
    `admin_audit_log` row is written per accepted call, carrying
    `fromTier`, `toTier`, `reason`, `changed` and `ok`. A failed transition is
    recorded with `ok: false`; a no-op with `changed: false`.
  - **There is no self-serve tier change.** A tenant `owner` gets `404` from
    this endpoint even for their own tenant; upgrades remain Stripe checkout
    only (`createCheckoutSession`). A wrong flip is fixed by flipping back, and
    both rows stay in the audit log — there is no undo and no expiry.

---

## 5. Upgrade Moments (UX)

Deliberate, contextual upgrade prompts — never dark patterns:

1. Hitting 80%/100% of submissions → banner + email with one-click upgrade.
2. Attempting a gated action (CSV import, adding a connector, 3rd form) → inline modal explaining the feature with tier comparison.
3. Inviting a second user on Free → seat explanation.
4. Form analytics teaser on Free (blurred chart + "See your conversion rate on Premium").

---

## 6. Open Questions

- Should submissions overage on Premium be auto-billed or opt-in?
- Per-seat vs flat pricing for Premium — flat with included seats proposed above.
- Nonprofit/education discount?
- Does the Free tier include the Scheduling plugin, or swap it for Invoicing-lite?
