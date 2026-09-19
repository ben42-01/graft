/**
 * QA seed — deterministic fixtures (docs/WORKFLOW.md §5.2).
 *
 * Fixed ObjectIds, fixed emails, fixed counts. Bruno assertions reference these
 * values directly, so nothing here may become random or time-dependent: if an
 * assertion can flake, this file is the reason. The QA stack is ephemeral, so
 * this always runs against an empty database.
 *
 * Edge-case tenants are deliberate — a tenant AT its quota, and a downgraded
 * tenant sitting over the free limits with read-only resources.
 */
import { ObjectId, type Db } from "mongodb";
import { connect, COLLECTIONS } from "./lib/db";
import { TIER_LIMITS } from "../src/server/tiers";
import { billingPeriod, LIFETIME_PERIOD } from "../src/server/services/meters";
import { TRIAL_DAYS } from "../src/server/services/billing";
import { hashRefreshToken, REFRESH_TTL_SECONDS } from "../src/server/auth/refresh-tokens";
import { hashVerificationToken } from "../src/server/services/accounts";
import { hashPassword } from "../src/server/auth/passwords";

/**
 * The meter period is the *current* one, not a hardcoded one: the app looks up
 * meters by the period it computes at request time, so a pinned period would
 * leave the at-quota tenant looking empty and the hard-stop test would silently
 * pass for the wrong reason. The counts are what assertions depend on, and those
 * are fixed.
 *
 * Periods run from the tenant's billing anniversary (GRAFT-05 AC6), so every QA
 * tenant is anchored to the 1st — that makes the period the calendar month and
 * keeps the fixture independent of which day of the month QA happens to run on.
 */
const BILLING_ANCHOR_DAY = 1;
const PERIOD = billingPeriod(BILLING_ANCHOR_DAY, new Date());

/** Everything else is pinned — no assertion may depend on the clock. */
const FIXED_DATE = new Date("2026-01-15T12:00:00.000Z");

/**
 * The plaintext of the seeded email-verification token. Shaped to satisfy
 * `verificationTokenSchema` (20-128 of `[A-Za-z0-9_-]`) and shared verbatim
 * with `bruno/auth/verify-email.bru`, which spends it.
 */
const VERIFICATION_TOKEN = "qa0verify0000000000000000000000000000000001";

const oid = (n: number) => new ObjectId(n.toString(16).padStart(24, "0"));

const IDS = {
  tenantFree: oid(1),
  tenantPremium: oid(2),
  tenantAtQuota: oid(3),
  tenantDowngraded: oid(4),
  // GRAFT-15 — isolated from the tenants above on purpose: the webhook tests
  // mutate this tenant's tier in place, and reusing e.g. tenantFree would
  // make billing tests order-dependent with every other suite that assumes
  // qa-free stays on Free.
  tenantBilling: oid(5),
  // GRAFT-15 — starts Premium, already over the Free limits it will fall
  // back to, so bruno/billing/webhook-downgrade.bru can fire
  // customer.subscription.deleted directly and observe the transition,
  // without depending on webhook-idempotency.bru having run first.
  tenantBillingDowngrade: oid(6),
  // GRAFT-26 AC8 — a tenant mid-trial, so bruno/billing/trial-days-remaining.bru
  // can read a real number off GET /api/v1/me. Its own tenant rather than a
  // flag on qa-premium: every existing assertion that qa-premium is a plain
  // paying Premium tenant has to keep holding exactly as it did.
  tenantTrialling: oid(7),
  // GRAFT-27.1 — the platform-admin fixtures get their own tenant rather than
  // joining qa-premium: every existing assertion about qa-premium's membership
  // has to keep holding exactly as it did, and an admin surface test that
  // changed another suite's fixture would be the wrong kind of coupling.
  // Premium tier on purpose — the free tenant's api rate-limit budget (60/min)
  // is already fully spent by the rest of the Bruno suite.
  tenantPlatform: oid(8),
  // GRAFT-27.4 — the manual tier override's own target tenant, and the one
  // fixture in this file that a Bruno suite deliberately *mutates*: the
  // override endpoint flips its tier, freezes its meters and unpublishes its
  // overflow forms. It therefore cannot be qa-premium, qa-free or qa-platform,
  // every one of which other suites assert stays exactly where it is. Premium
  // and already over Free's caps, so a single POST proves the whole downgrade
  // transition. Bruno needs a fresh seed per run for this tenant in particular
  // (docs/WORKFLOW.md §5.2) — the suite leaves it on `free`, not `premium`.
  tenantOverride: oid(9),
  // GRAFT-27.4 — and a *second* override tenant, for the upgrade half, for
  // exactly the reason tenantBillingDowngrade exists beside tenantBilling: the
  // two suites mutate the same field in opposite directions. Sharing one
  // tenant made them order-dependent in a way that is easy to miss — the
  // upgrade suite's setup flip to Free unpublishes qa-override's overflow
  // form, `applyUpgrade` deliberately never republishes it (docs/TIERS.md §4:
  // re-publishing is the owner's choice), and the downgrade suite then found
  // two published forms where it seeded three. This tenant starts on Free,
  // holds no forms and no records, and exists only to be raised.
  tenantOverrideUpgrade: oid(10),
  userFreeOwner: oid(11),
  userPremiumOwner: oid(12),
  userPremiumMember: oid(13),
  userAtQuotaOwner: oid(14),
  userDowngradedOwner: oid(15),
  // GRAFT-03.2 fixtures. New ids rather than edits to the five above, so every
  // assertion written against those still holds exactly as it did.
  userTwoTenants: oid(16),
  userUnverified: oid(17),
  userBillingOwner: oid(18),
  userBillingDowngradeOwner: oid(19),
  userTrialling: oid(20),
  // GRAFT-27.1 AC1 — the only seeded user with `isPlatformAdmin: true`.
  userPlatformAdmin: oid(80),
  // GRAFT-27.1 AC3 — holds BOTH tenant roles and no platform flag: the exact
  // collision the contract names, since "admin" means two different things.
  userPlatformTenantOwner: oid(81),
  // GRAFT-27.4 AC6 — the owner of qa-override, used to prove that a tenant
  // owner cannot flip their OWN tenant's tier.
  userOverrideOwner: oid(82),
  entityBillingDowngrade: oid(25),
  entityFreeCustomers: oid(21),
  entityPremiumCustomers: oid(22),
  entityDowngradedExtra: oid(23),
  // GRAFT-09 — qa-at-quota needs its own entity: the public submit endpoint
  // fetches the entity tenant-scoped (so it never leaks another tenant's
  // schema even to its own owner), and formAtQuota previously pointed at
  // entityFreeCustomers, which belongs to tenantFree, not tenantAtQuota.
  entityAtQuotaCustomers: oid(24),
  formFreePublic: oid(31),
  formAtQuota: oid(32),
  formDowngradedUnpublished: oid(33),
  formBillingDowngradeOldest: oid(34),
  formBillingDowngradeMiddle: oid(35),
  formBillingDowngradeNewest: oid(36),
  // GRAFT-24 — a published form with a Stripe payment link on it, so the
  // submit contract can be proven without a Bruno request having to configure
  // its own fixture first (and without leaving payment switched on for
  // qa-public-form, which public-submit.bru asserts is an ordinary form).
  formFreePayment: oid(37),
  // GRAFT-24 — the config surface is exercised against the *premium* tenant so
  // the hostile-URL table (a dozen refused PATCHes in one minute) spends that
  // tenant's api rate-limit budget rather than the free tenant's 60/min, which
  // the rest of the Bruno suite shares.
  formPremiumPayment: oid(38),
  recordFreeFirst: oid(41),
  // BMS inventory (docs/BMS_EXTENSION.md §2.1). A bookable resource needs an
  // entity to be an instance of, a record to *be* the instance, and a pool to
  // say how it may be allocated — so all three are seeded rather than built by
  // the Bruno suite, which would then be testing its own setup.
  entityFreeRentals: oid(26),
  // GRAFT-27.4 — qa-override's own entity, records and forms. Its own set, so
  // "the record count did not change" can be asserted over a tenant nothing
  // else writes to.
  entityOverrideCustomers: oid(27),
  recordOverrideFirst: oid(47),
  recordOverrideSecond: oid(48),
  formOverrideOldest: oid(51),
  formOverrideMiddle: oid(52),
  formOverrideNewest: oid(53),
  recordFreeBoat: oid(46),
  poolFreeBoat: oid(101),
  // Owned by qa-at-quota, so the isolation cases have a real id to quote.
  poolOtherTenant: oid(102),
} as const;

const RENTAL_FIELDS = [
  { key: "name", label: "Name", type: "text" as const, required: true },
  { key: "hourly_rate", label: "Hourly rate", type: "number" as const, required: false },
];

const CUSTOMER_FIELDS = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "email", label: "Email", type: "email", required: true },
  { key: "phone", label: "Phone", type: "phone" },
];

const base = { createdAt: FIXED_DATE, updatedAt: FIXED_DATE, seedBatch: "qa-fixtures" };

/**
 * Every QA user shares this password, and bruno/environments/*.bru presents it
 * by value as `qaPassword` (GRAFT-03.2). The stored value is a real argon2id
 * hash — the fixture exercises the same verification path a production login
 * does, so a broken hashing config fails the suite instead of passing it.
 *
 * The digest is *not* pinned, because argon2id salts randomly and a pinned hash
 * would either need a pinned salt (weakening the very thing under test) or would
 * change on every run. What is pinned is the password, which is what assertions
 * actually use.
 *
 * This is not a credential. It exists only inside the ephemeral QA database that
 * `npm run qa:db:down -v` destroys after every run, and authorises nothing
 * anywhere else.
 */
const QA_PASSWORD = "qa-fixture-password-2026";

async function assertEmpty(db: Db) {
  for (const name of COLLECTIONS) {
    const count = await db.collection(name).countDocuments({}, { limit: 1 });
    if (count > 0) {
      console.error(
        `[graft] '${name}' is not empty — the QA stack must be ephemeral.\n` +
          `        run \`npm run qa:db:down && npm run qa:db\` and reseed.`,
      );
      process.exit(1);
    }
  }
}

async function main() {
  const { client, db } = await connect();
  try {
    await assertEmpty(db);

    await db.collection("tenants").insertMany([
      {
        _id: IDS.tenantFree,
        name: "QA Free Tenant",
        slug: "qa-free",
        tier: "free",
        limits: TIER_LIMITS.free,
        billingAnchorDay: BILLING_ANCHOR_DAY,
        settings: { currency: "EUR", timezone: "UTC", locale: "en" },
        ...base,
      },
      {
        _id: IDS.tenantPremium,
        name: "QA Premium Tenant",
        slug: "qa-premium",
        tier: "premium",
        limits: TIER_LIMITS.premium,
        billingAnchorDay: BILLING_ANCHOR_DAY,
        settings: { currency: "EUR", timezone: "UTC", locale: "en" },
        ...base,
      },
      {
        _id: IDS.tenantAtQuota,
        name: "QA At Quota Tenant",
        slug: "qa-at-quota",
        tier: "free",
        limits: TIER_LIMITS.free,
        billingAnchorDay: BILLING_ANCHOR_DAY,
        settings: { currency: "EUR", timezone: "UTC", locale: "en" },
        ...base,
      },
      {
        _id: IDS.tenantDowngraded,
        name: "QA Downgraded Tenant",
        slug: "qa-downgraded",
        tier: "free",
        limits: TIER_LIMITS.free,
        downgradedAt: FIXED_DATE,
        // Over-limit resources after the downgrade: readable, never writable,
        // never deleted (docs/TIERS.md §4, GRAFT-05 AC7).
        readOnly: ["records", "entities"],
        billingAnchorDay: BILLING_ANCHOR_DAY,
        settings: { currency: "EUR", timezone: "UTC", locale: "en" },
        ...base,
      },
      {
        // GRAFT-15 — starts Free with no Stripe identity yet; the webhook
        // suite raises and lowers it through the real checkout/webhook path.
        _id: IDS.tenantBilling,
        name: "QA Billing Tenant",
        slug: "qa-billing",
        tier: "free",
        limits: TIER_LIMITS.free,
        billingAnchorDay: BILLING_ANCHOR_DAY,
        settings: { currency: "EUR", timezone: "UTC", locale: "en" },
        ...base,
      },
      {
        // GRAFT-15 AC4 — Premium and already over Free's limits, so firing
        // customer.subscription.deleted against this tenant proves the real
        // downgrade transition end to end, independent of any other billing
        // fixture's state.
        _id: IDS.tenantBillingDowngrade,
        name: "QA Billing Downgrade Tenant",
        slug: "qa-billing-downgrade",
        tier: "premium",
        limits: TIER_LIMITS.premium,
        billing: {
          stripeCustomerId: "cus_qa_billing_downgrade",
          stripeSubscriptionId: "sub_qa_billing_downgrade",
        },
        billingAnchorDay: BILLING_ANCHOR_DAY,
        settings: { currency: "EUR", timezone: "UTC", locale: "en" },
        ...base,
      },
      {
        // GRAFT-26 AC1/AC8 — what signup() now produces: Premium by trial,
        // with the Premium limits materialised, and no Stripe identity at all
        // (no card is asked for). `trialEndsAt` is relative to the seed run
        // rather than FIXED_DATE, because "days remaining" is only a number
        // while the trial is still live — the assertion that stays stable is
        // TRIAL_DAYS itself, since the whole-day count rounds up.
        _id: IDS.tenantTrialling,
        name: "QA Trialling Tenant",
        slug: "qa-trialling",
        tier: "premium",
        limits: TIER_LIMITS.premium,
        billing: {
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000),
        },
        billingAnchorDay: BILLING_ANCHOR_DAY,
        settings: { currency: "EUR", timezone: "UTC", locale: "en" },
        ...base,
      },
      {
        // GRAFT-27.1 — the tenant a platform admin happens to belong to. It is
        // an ordinary tenant in every respect: the admin surface never reads it
        // and never scopes by it (AC10). It exists only because there is no
        // tenant-less login, and this issue does not invent one.
        _id: IDS.tenantPlatform,
        name: "QA Platform Tenant",
        slug: "qa-platform",
        tier: "premium",
        limits: TIER_LIMITS.premium,
        billingAnchorDay: BILLING_ANCHOR_DAY,
        settings: { currency: "EUR", timezone: "UTC", locale: "en" },
        ...base,
      },
      {
        // GRAFT-27.4 — the tenant the override suite moves. Premium, already
        // over Free's entities (3) and records (2,000) caps, and holding three
        // public published forms against Free's cap of 2, so one POST exercises
        // the freeze *and* the unpublish. It carries a live Stripe subscription
        // on purpose: the contract's headline out-of-scope note is that an
        // override changes Graft's tier and nothing in Stripe, and a fixture
        // with no subscription could not show that.
        _id: IDS.tenantOverride,
        name: "QA Override Tenant",
        slug: "qa-override",
        tier: "premium",
        limits: TIER_LIMITS.premium,
        readOnly: [],
        downgradedAt: null,
        billing: {
          stripeCustomerId: "cus_qa_override",
          stripeSubscriptionId: "sub_qa_override",
        },
        billingAnchorDay: BILLING_ANCHOR_DAY,
        settings: { currency: "EUR", timezone: "UTC", locale: "en" },
        ...base,
      },
      {
        // GRAFT-27.4 AC1 — the upgrade half's own tenant. Free, with a Stripe
        // customer and subscription attached so the "an override changes
        // Graft's tier and nothing in Stripe" assertion has something to be
        // about. No forms, no records, no meters: raising a tenant touches
        // none of them, and a fixture with nothing to lose cannot make the
        // downgrade suite order-dependent.
        _id: IDS.tenantOverrideUpgrade,
        name: "QA Override Upgrade Tenant",
        slug: "qa-override-upgrade",
        tier: "free",
        limits: TIER_LIMITS.free,
        readOnly: [],
        downgradedAt: null,
        billing: {
          stripeCustomerId: "cus_qa_override_upgrade",
          stripeSubscriptionId: "sub_qa_override_upgrade",
        },
        billingAnchorDay: BILLING_ANCHOR_DAY,
        settings: { currency: "EUR", timezone: "UTC", locale: "en" },
        ...base,
      },
    ]);

    // One hash for all five: argon2id is deliberately slow, and five identical
    // computations would add a second to every QA run for no extra coverage.
    const passwordHash = await hashPassword(QA_PASSWORD);

    await db.collection("users").insertMany([
      {
        _id: IDS.userFreeOwner,
        email: "owner@qa-free.test",
        name: "QA Free Owner",
        emailVerifiedAt: FIXED_DATE,
        passwordHash,
        memberships: [{ tenantId: IDS.tenantFree, roles: ["owner"] }],
        ...base,
      },
      {
        _id: IDS.userPremiumOwner,
        email: "owner@qa-premium.test",
        name: "QA Premium Owner",
        emailVerifiedAt: FIXED_DATE,
        passwordHash,
        memberships: [{ tenantId: IDS.tenantPremium, roles: ["owner"] }],
        ...base,
      },
      {
        _id: IDS.userPremiumMember,
        email: "member@qa-premium.test",
        name: "QA Premium Member",
        emailVerifiedAt: FIXED_DATE,
        passwordHash,
        memberships: [{ tenantId: IDS.tenantPremium, roles: ["member"] }],
        ...base,
      },
      {
        _id: IDS.userAtQuotaOwner,
        email: "owner@qa-at-quota.test",
        name: "QA At Quota Owner",
        emailVerifiedAt: FIXED_DATE,
        passwordHash,
        memberships: [{ tenantId: IDS.tenantAtQuota, roles: ["owner"] }],
        ...base,
      },
      {
        _id: IDS.userDowngradedOwner,
        email: "owner@qa-downgraded.test",
        name: "QA Downgraded Owner",
        emailVerifiedAt: FIXED_DATE,
        passwordHash,
        memberships: [{ tenantId: IDS.tenantDowngraded, roles: ["owner"] }],
        ...base,
      },
      {
        // AC6 — the only user in two tenants. bruno/auth/switch-tenant.bru logs
        // in as this account, lands in free, and switches to premium.
        _id: IDS.userTwoTenants,
        email: "both@qa.test",
        name: "QA Two Tenant User",
        emailVerifiedAt: FIXED_DATE,
        passwordHash,
        memberships: [
          { tenantId: IDS.tenantFree, roles: ["member"] },
          { tenantId: IDS.tenantPremium, roles: ["admin"] },
        ],
        ...base,
      },
      {
        // AC3 — verified nowhere. Logging in as this account must be refused
        // with EMAIL_NOT_VERIFIED even though the password is correct.
        _id: IDS.userUnverified,
        email: "unverified@qa.test",
        name: "QA Unverified User",
        emailVerifiedAt: null,
        passwordHash,
        memberships: [{ tenantId: IDS.tenantFree, roles: ["member"] }],
        ...base,
      },
      {
        _id: IDS.userBillingOwner,
        email: "owner@qa-billing.test",
        name: "QA Billing Owner",
        emailVerifiedAt: FIXED_DATE,
        passwordHash,
        memberships: [{ tenantId: IDS.tenantBilling, roles: ["owner"] }],
        ...base,
      },
      {
        _id: IDS.userBillingDowngradeOwner,
        email: "owner@qa-billing-downgrade.test",
        name: "QA Billing Downgrade Owner",
        emailVerifiedAt: FIXED_DATE,
        passwordHash,
        memberships: [{ tenantId: IDS.tenantBillingDowngrade, roles: ["owner"] }],
        ...base,
      },
      {
        // GRAFT-27.4 AC6 — the owner of the tenant the override suite targets,
        // carrying no `isPlatformAdmin` field at all. There is no self-serve
        // tier change: this account gets a 404 from the override endpoint even
        // for its own workspace.
        _id: IDS.userOverrideOwner,
        email: "owner@qa-override.test",
        name: "QA Override Owner",
        emailVerifiedAt: FIXED_DATE,
        passwordHash,
        memberships: [{ tenantId: IDS.tenantOverride, roles: ["owner", "admin"] }],
        ...base,
      },
      {
        // GRAFT-26 AC8 — logs in for bruno/billing/trial-days-remaining.bru.
        _id: IDS.userTrialling,
        email: "owner@qa-trialling.test",
        name: "QA Trialling Owner",
        emailVerifiedAt: FIXED_DATE,
        passwordHash,
        memberships: [{ tenantId: IDS.tenantTrialling, roles: ["owner"] }],
        ...base,
      },
      {
        // GRAFT-27.1 AC1 — the only account in the whole fixture set with the
        // platform flag. It is otherwise an entirely ordinary user: it signs in
        // through the same login, holds the same kind of tenant session, and
        // carries nothing special on its access token. The flag lives here, in
        // the document, and is re-read on every admin request (AC5).
        _id: IDS.userPlatformAdmin,
        email: "platform-admin@qa.test",
        name: "QA Platform Admin",
        emailVerifiedAt: FIXED_DATE,
        passwordHash,
        memberships: [{ tenantId: IDS.tenantPlatform, roles: ["owner"] }],
        isPlatformAdmin: true,
        ...base,
      },
      {
        // GRAFT-27.1 AC3 — the negative case, and the reason it is worth a
        // fixture of its own: this account holds BOTH tenant roles, `owner` and
        // `admin`, and still gets a 404 from /api/v1/admin/*. The tenant role
        // named "admin" is not the platform flag and must never become it.
        // No `isPlatformAdmin` field at all, which is also AC2's "absent" case.
        _id: IDS.userPlatformTenantOwner,
        email: "owner@qa-platform.test",
        name: "QA Platform Tenant Owner",
        emailVerifiedAt: FIXED_DATE,
        passwordHash,
        memberships: [{ tenantId: IDS.tenantPlatform, roles: ["owner", "admin"] }],
        ...base,
      },
    ]);

    await db.collection("plugins_enabled").insertMany([
      { _id: oid(51), tenantId: IDS.tenantFree, pluginId: "contacts", config: {}, ...base },
      { _id: oid(52), tenantId: IDS.tenantFree, pluginId: "forms", config: {}, ...base },
      { _id: oid(53), tenantId: IDS.tenantPremium, pluginId: "contacts", config: {}, ...base },
      { _id: oid(54), tenantId: IDS.tenantPremium, pluginId: "forms", config: {}, ...base },
      { _id: oid(55), tenantId: IDS.tenantPremium, pluginId: "invoicing", config: {}, ...base },
    ]);

    await db.collection("entity_defs").insertMany([
      {
        // BMS — the schema a bookable resource is an instance of.
        _id: IDS.entityFreeRentals,
        tenantId: IDS.tenantFree,
        key: "rental_items",
        name: "Rental Items",
        fields: RENTAL_FIELDS,
        schemaVersion: 1,
        readOnly: false,
        ...base,
      },
      {
        _id: IDS.entityFreeCustomers,
        tenantId: IDS.tenantFree,
        key: "customers",
        name: "Customers",
        fields: CUSTOMER_FIELDS,
        schemaVersion: 1,
        readOnly: false,
        ...base,
      },
      {
        _id: IDS.entityPremiumCustomers,
        tenantId: IDS.tenantPremium,
        key: "customers",
        name: "Customers",
        fields: CUSTOMER_FIELDS,
        schemaVersion: 1,
        readOnly: false,
        ...base,
      },
      {
        // Over the free limit after downgrade — read-only, never deleted
        _id: IDS.entityDowngradedExtra,
        tenantId: IDS.tenantDowngraded,
        key: "legacy_orders",
        name: "Legacy Orders",
        fields: CUSTOMER_FIELDS,
        schemaVersion: 1,
        readOnly: true,
        ...base,
      },
      {
        _id: IDS.entityAtQuotaCustomers,
        tenantId: IDS.tenantAtQuota,
        key: "customers",
        name: "Customers",
        fields: CUSTOMER_FIELDS,
        schemaVersion: 1,
        readOnly: false,
        ...base,
      },
      {
        _id: IDS.entityBillingDowngrade,
        tenantId: IDS.tenantBillingDowngrade,
        key: "customers",
        name: "Customers",
        fields: CUSTOMER_FIELDS,
        schemaVersion: 1,
        readOnly: false,
        ...base,
      },
      {
        // GRAFT-27.4 — qa-override's entity, so its records and forms hang off
        // a definition no other suite touches.
        _id: IDS.entityOverrideCustomers,
        tenantId: IDS.tenantOverride,
        key: "customers",
        name: "Customers",
        fields: CUSTOMER_FIELDS,
        schemaVersion: 1,
        readOnly: false,
        ...base,
      },
    ]);

    // BMS — the bookable resource itself. On `rental_items`, not `customers`,
    // so the "exactly 3 records" count below stays exactly 3: record lists are
    // per-entity, and nothing enumerates a tenant's records across entities.
    await db.collection("records").insertOne({
      _id: IDS.recordFreeBoat,
      tenantId: IDS.tenantFree,
      entityDefId: IDS.entityFreeRentals,
      schemaVersion: 1,
      data: { name: "24ft Pontoon Boat", hourly_rate: 150 },
      deletedAt: null,
      ...base,
    });

    await db.collection("inventory_pools").insertMany([
      {
        _id: IDS.poolFreeBoat,
        tenantId: IDS.tenantFree,
        entityDefId: IDS.entityFreeRentals,
        recordId: IDS.recordFreeBoat,
        strategy: "individual_asset",
        totalQuantity: 1,
        // 30 minutes of cleaning between hires — the worked example in
        // docs/BMS_EXTENSION.md §3.2, so the Bruno suite can assert on a
        // buffer that is actually doing something.
        bufferMinutes: 30,
        autoLockOnCheckout: true,
        allocationVersion: 0,
        deletedAt: null,
        ...base,
      },
      {
        // Exists only so the isolation cases have a real id belonging to
        // someone else — the same role formAtQuota plays for forms.
        _id: IDS.poolOtherTenant,
        tenantId: IDS.tenantAtQuota,
        entityDefId: IDS.entityAtQuotaCustomers,
        recordId: oid(47),
        strategy: "pooled_quantity",
        totalQuantity: 10,
        bufferMinutes: 0,
        autoLockOnCheckout: true,
        allocationVersion: 0,
        deletedAt: null,
        ...base,
      },
    ]);

    // Exactly 3 records for the free tenant — assertions count on this.
    await db.collection("records").insertMany([
      {
        _id: IDS.recordFreeFirst,
        tenantId: IDS.tenantFree,
        entityDefId: IDS.entityFreeCustomers,
        schemaVersion: 1,
        data: { name: "Ada Lovelace", email: "ada@qa-free.test", phone: "+353 1 000 0001" },
        deletedAt: null,
        ...base,
      },
      {
        _id: oid(42),
        tenantId: IDS.tenantFree,
        entityDefId: IDS.entityFreeCustomers,
        schemaVersion: 1,
        data: { name: "Grace Hopper", email: "grace@qa-free.test", phone: "+353 1 000 0002" },
        deletedAt: null,
        ...base,
      },
      {
        _id: oid(43),
        tenantId: IDS.tenantFree,
        entityDefId: IDS.entityFreeCustomers,
        schemaVersion: 1,
        data: { name: "Alan Turing", email: "alan@qa-free.test", phone: "+353 1 000 0003" },
        deletedAt: null,
        ...base,
      },
      // Premium tenant's record — the target of every cross-tenant access test.
      {
        _id: oid(44),
        tenantId: IDS.tenantPremium,
        entityDefId: IDS.entityPremiumCustomers,
        schemaVersion: 1,
        data: {
          name: "Do Not Leak",
          email: "secret@qa-premium.test",
          phone: "+353 1 999 9999",
        },
        deletedAt: null,
        ...base,
      },
    ]);

    await db.collection("forms").insertMany([
      {
        _id: IDS.formFreePublic,
        tenantId: IDS.tenantFree,
        entityDefId: IDS.entityFreeCustomers,
        name: "QA Public Form",
        slug: "qa-public-form",
        publicSlug: "qa-free/qa-public-form",
        visibility: "public",
        published: true,
        enabled: true,
        killSwitchAt: null,
        killSwitchBy: null,
        fields: CUSTOMER_FIELDS,
        showBadge: true,
        deletedAt: null,
        ...base,
      },
      {
        _id: IDS.formFreePayment,
        tenantId: IDS.tenantFree,
        entityDefId: IDS.entityFreeCustomers,
        name: "QA Payment Form",
        slug: "qa-payment-form",
        publicSlug: "qa-free/qa-payment-form",
        visibility: "public",
        published: true,
        enabled: true,
        killSwitchAt: null,
        killSwitchBy: null,
        fields: CUSTOMER_FIELDS,
        // A real Stripe payment-link URL shape, and not a secret of any kind:
        // a payment link is public by design (GRAFT-24). This one belongs to
        // nobody and leads nowhere — the QA suite never follows it.
        payment: {
          mode: "link",
          link: { url: "https://buy.stripe.com/qa_payment_link?prefilled_email=x" },
          required: true,
        },
        showBadge: true,
        deletedAt: null,
        ...base,
      },
      {
        _id: IDS.formPremiumPayment,
        tenantId: IDS.tenantPremium,
        entityDefId: IDS.entityPremiumCustomers,
        name: "QA Premium Payment Form",
        slug: "qa-premium-payment-form",
        publicSlug: "qa-premium/qa-premium-payment-form",
        visibility: "public",
        published: true,
        enabled: true,
        killSwitchAt: null,
        killSwitchBy: null,
        fields: CUSTOMER_FIELDS,
        // Payment off to begin with: bruno/forms/payment-link-config.bru turns
        // it on and off again against this form.
        payment: null,
        showBadge: true,
        deletedAt: null,
        ...base,
      },
      {
        _id: IDS.formAtQuota,
        tenantId: IDS.tenantAtQuota,
        entityDefId: IDS.entityAtQuotaCustomers,
        name: "QA Quota Form",
        slug: "qa-quota-form",
        publicSlug: "qa-at-quota/qa-quota-form",
        visibility: "public",
        published: true,
        enabled: true,
        killSwitchAt: null,
        killSwitchBy: null,
        fields: CUSTOMER_FIELDS,
        showBadge: true,
        deletedAt: null,
        ...base,
      },
      {
        _id: IDS.formDowngradedUnpublished,
        tenantId: IDS.tenantDowngraded,
        entityDefId: IDS.entityDowngradedExtra,
        name: "QA Unpublished Form",
        slug: "qa-unpublished-form",
        publicSlug: "qa-downgraded/qa-unpublished-form",
        visibility: "public",
        published: false, // unpublished by downgrade, data retained
        enabled: true,
        killSwitchAt: null,
        killSwitchBy: null,
        fields: CUSTOMER_FIELDS,
        showBadge: true,
        deletedAt: null,
        ...base,
      },
      // GRAFT-15 AC4 — three public, published forms; Free's activeForms
      // limit is 2, so the downgrade webhook must unpublish exactly the
      // newest one and leave the older two active. Distinct createdAt makes
      // "oldest kept" deterministic.
      {
        _id: IDS.formBillingDowngradeOldest,
        tenantId: IDS.tenantBillingDowngrade,
        entityDefId: IDS.entityBillingDowngrade,
        name: "QA Billing Downgrade Oldest",
        slug: "qa-billing-downgrade-oldest",
        publicSlug: "qa-billing-downgrade/qa-billing-downgrade-oldest",
        visibility: "public",
        published: true,
        enabled: true,
        killSwitchAt: null,
        killSwitchBy: null,
        fields: CUSTOMER_FIELDS,
        showBadge: true,
        deletedAt: null,
        ...base,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        _id: IDS.formBillingDowngradeMiddle,
        tenantId: IDS.tenantBillingDowngrade,
        entityDefId: IDS.entityBillingDowngrade,
        name: "QA Billing Downgrade Middle",
        slug: "qa-billing-downgrade-middle",
        publicSlug: "qa-billing-downgrade/qa-billing-downgrade-middle",
        visibility: "public",
        published: true,
        enabled: true,
        killSwitchAt: null,
        killSwitchBy: null,
        fields: CUSTOMER_FIELDS,
        showBadge: true,
        deletedAt: null,
        ...base,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      },
      {
        _id: IDS.formBillingDowngradeNewest,
        tenantId: IDS.tenantBillingDowngrade,
        entityDefId: IDS.entityBillingDowngrade,
        name: "QA Billing Downgrade Newest",
        slug: "qa-billing-downgrade-newest",
        publicSlug: "qa-billing-downgrade/qa-billing-downgrade-newest",
        visibility: "public",
        published: true,
        enabled: true,
        killSwitchAt: null,
        killSwitchBy: null,
        fields: CUSTOMER_FIELDS,
        showBadge: true,
        deletedAt: null,
        ...base,
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
      },
      // GRAFT-27.4 — qa-override's three public published forms against Free's
      // activeForms cap of 2. A manual override to `free` must unpublish
      // exactly the newest and leave the older two published, by the same
      // applyDowngradePolicy the Stripe webhook runs. Distinct createdAt makes
      // "oldest kept" deterministic.
      ...(["Oldest", "Middle", "Newest"] as const).map((label, n) => ({
        _id: [IDS.formOverrideOldest, IDS.formOverrideMiddle, IDS.formOverrideNewest][n]!,
        tenantId: IDS.tenantOverride,
        entityDefId: IDS.entityOverrideCustomers,
        name: `QA Override ${label}`,
        slug: `qa-override-${label.toLowerCase()}`,
        publicSlug: `qa-override/qa-override-${label.toLowerCase()}`,
        visibility: "public",
        published: true,
        enabled: true,
        killSwitchAt: null,
        killSwitchBy: null,
        fields: CUSTOMER_FIELDS,
        showBadge: true,
        deletedAt: null,
        ...base,
        createdAt: new Date(`2026-02-0${n + 1}T00:00:00.000Z`),
      })),
    ]);

    // GRAFT-27.4 — two real records on qa-override. They are what
    // "no document is deleted" is counted over in
    // bruno/admin/tenant-tier-override-downgrade.bru: the downgrade freezes the
    // `records` meter and must leave both rows exactly where they are.
    await db.collection("records").insertMany([
      {
        _id: IDS.recordOverrideFirst,
        tenantId: IDS.tenantOverride,
        entityDefId: IDS.entityOverrideCustomers,
        data: { name: "Override Customer One", email: "one@qa-override.test" },
        deletedAt: null,
        ...base,
      },
      {
        _id: IDS.recordOverrideSecond,
        tenantId: IDS.tenantOverride,
        entityDefId: IDS.entityOverrideCustomers,
        data: { name: "Override Customer Two", email: "two@qa-override.test" },
        deletedAt: null,
        ...base,
      },
    ]);

    await db.collection("usage_meters").insertMany([
      {
        _id: oid(61),
        tenantId: IDS.tenantFree,
        meter: "form_submissions",
        period: PERIOD,
        count: 5,
        ...base,
      },
      {
        _id: oid(62),
        tenantId: IDS.tenantPremium,
        meter: "form_submissions",
        period: PERIOD,
        count: 500,
        ...base,
      },
      {
        // AT the free limit exactly — the hard-stop test hits this one
        _id: oid(63),
        tenantId: IDS.tenantAtQuota,
        meter: "form_submissions",
        period: PERIOD,
        count: TIER_LIMITS.free.submissionsPerMonth!,
        ...base,
      },
      {
        _id: oid(64),
        tenantId: IDS.tenantDowngraded,
        meter: "form_submissions",
        period: PERIOD,
        count: 100,
        ...base,
      },
      // GRAFT-13 AC6 — the free tenant's `dashboards` meter (never resets,
      // METERS.dashboards) at exactly TIER_LIMITS.free.dashboards, matching
      // the one dashboard seeded below. A second create is the hard stop.
      {
        _id: oid(65),
        tenantId: IDS.tenantFree,
        meter: "dashboards",
        period: LIFETIME_PERIOD,
        count: TIER_LIMITS.free.dashboards!,
        ...base,
      },
      // GRAFT-15 AC4 — over Free's entities (3) and records (2,000) limits,
      // so the downgrade webhook must freeze both read-only.
      {
        _id: oid(66),
        tenantId: IDS.tenantBillingDowngrade,
        meter: "entities",
        period: LIFETIME_PERIOD,
        count: 10,
        ...base,
      },
      {
        _id: oid(67),
        tenantId: IDS.tenantBillingDowngrade,
        meter: "records",
        period: LIFETIME_PERIOD,
        count: 3_000,
        ...base,
      },
      // GRAFT-27.4 — qa-override, over Free's entities (3) and records (2,000)
      // caps, so a manual override to `free` must freeze both read-only. The
      // meter counts are deliberately larger than the two seeded record rows:
      // a freeze is a decision about the *meter*, and proving nothing is
      // deleted means counting the rows, which is what the Bruno suite does.
      {
        _id: oid(68),
        tenantId: IDS.tenantOverride,
        meter: "entities",
        period: LIFETIME_PERIOD,
        count: 12,
        ...base,
      },
      {
        _id: oid(69),
        tenantId: IDS.tenantOverride,
        meter: "records",
        period: LIFETIME_PERIOD,
        count: 4_200,
        ...base,
      },
    ]);

    // GRAFT-13 — the free tenant's one dashboard, deliberately at its tier
    // limit (dashboards: 1). Paired with the usage_meters row below so a
    // second create is refused as the *actual* hard stop (AC6), the same
    // convention formAtQuota uses for form_submissions.
    await db.collection("dashboards").insertOne({
      _id: oid(71),
      tenantId: IDS.tenantFree,
      ownerId: IDS.userFreeOwner,
      name: "QA Dashboard",
      widgets: [
        {
          id: "w1",
          type: "record_list",
          config: { entityId: IDS.entityFreeCustomers.toHexString() },
          layout: { x: 0, y: 0, w: 1, h: 1 },
        },
      ],
      ...base,
    });

    /**
     * Refresh token fixtures (GRAFT-03.1). There is no login endpoint until
     * GRAFT-03.2, so the rotation contract can only be exercised from a token
     * that already exists — these are it, and bruno/environments/*.bru presents
     * them by value.
     *
     * These are not credentials. They exist only inside the ephemeral QA
     * database, which `npm run qa:db:down -v` destroys after every run, and they
     * authorise nothing anywhere else. Only the SHA-256 is stored, exactly as
     * the server stores a real one — the fixture proves the hashing path too.
     *
     * `expiresAt` is relative to now for the same reason PERIOD is: a pinned
     * date would silently expire and every rotation assertion would start
     * failing for a reason that has nothing to do with the code.
     */
    const refreshExpiry = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);
    const refreshFixture = (
      id: ObjectId,
      familyId: ObjectId,
      tenantId: ObjectId,
      userId: ObjectId,
      token: string,
      usedAt: Date | null = null,
    ) => ({
      _id: id,
      tenantId,
      userId,
      familyId,
      tokenHash: hashRefreshToken(token),
      expiresAt: refreshExpiry,
      usedAt,
      revokedAt: null,
      ...base,
    });

    const FREE = `${IDS.tenantFree.toHexString()}.`;
    await db.collection("refresh_tokens").insertMany([
      // Rotated by bruno/auth/refresh.bru, then replayed by refresh-replay.bru.
      refreshFixture(
        oid(91),
        oid(81),
        IDS.tenantFree,
        IDS.userFreeOwner,
        `${FREE}qa0rotate0000000000000000000000000000001`,
      ),
      // Family 0x82: one token already spent, one sibling never spent. Presenting
      // the spent one is reuse; the sibling must die with it (AC3).
      refreshFixture(
        oid(92),
        oid(82),
        IDS.tenantFree,
        IDS.userFreeOwner,
        `${FREE}qa0reuse0used000000000000000000000000002`,
        FIXED_DATE,
      ),
      refreshFixture(
        oid(93),
        oid(82),
        IDS.tenantFree,
        IDS.userFreeOwner,
        `${FREE}qa0reuse0sibling0000000000000000000003`,
      ),
      // A live token belonging to the *premium* tenant. The cross-tenant test
      // presents this secret under the free tenant's id and must be refused.
      refreshFixture(
        oid(94),
        oid(83),
        IDS.tenantPremium,
        IDS.userPremiumOwner,
        `${IDS.tenantPremium.toHexString()}.qa0premium000000000000000000000000000000004`,
      ),
    ]);

    /**
     * A spendable email-verification token for `unverified@qa.test`.
     *
     * `bruno/auth/verify-email.bru` used to carry a token somebody had copied
     * out of a log line by hand, which no seed ever produced — so it asserted
     * 204 and got 404 on every automated run. A live token is only ever
     * *logged*, never returned in a response body, so a contract test cannot
     * obtain one by signing up: it has to be planted here.
     *
     * One-shot by design, like the spent refresh-token fixtures above:
     * claiming it deletes it, so the request passes once per seed. CI reseeds
     * every run; locally, re-run `npm run qa:seed` before spending it again.
     */
    await db.collection("email_verification_tokens").insertOne({
      userId: IDS.userUnverified,
      tokenHash: hashVerificationToken(VERIFICATION_TOKEN),
      expiresAt: new Date(FIXED_DATE.getTime() + 365 * 24 * 60 * 60 * 1000),
    });

    /**
     * GRAFT-29.2 — activity-log fixtures, inserted directly (the write path is
     * GRAFT-29.4's job, not this contract's) so bruno/admin/activities-*.bru
     * has deterministic rows to read/filter/search. Shaped exactly like
     * `mongoActivityStore().append` writes them (src/server/services/
     * activity-log.ts) so this fixture cannot silently drift from what the
     * real writer produces.
     *
     * Spread across qa-premium and qa-free so bruno/admin/activities-list.bru
     * can prove the `tenantId` filter narrows the read, across five of the
     * five action families so `action` (exact and prefix) has real rows to
     * match, and across three consecutive days so `from`/`to` has a real
     * boundary to test.
     */
    const activityFixture = (
      n: number,
      over: Partial<{
        tenantId: ObjectId;
        actorType: "customer" | "system" | "admin";
        actorId: ObjectId | null;
        action: string;
        ok: boolean;
        at: Date;
        context: Record<string, unknown>;
      }>,
    ) => ({
      _id: oid(n),
      tenantId: IDS.tenantPremium,
      actorType: "system" as const,
      actorId: null,
      action: "account.login",
      ok: true,
      requestId: `qa-seed-activity-${n}`,
      at: new Date("2026-01-10T00:00:00.000Z"),
      context: {},
      ...over,
    });

    await db.collection("activities").insertMany([
      activityFixture(110, {
        tenantId: IDS.tenantPremium,
        actorType: "customer",
        actorId: IDS.userPremiumOwner,
        action: "account.login",
        ok: true,
        at: new Date("2026-01-10T00:00:00.000Z"),
        context: { method: "password" },
      }),
      activityFixture(111, {
        tenantId: IDS.tenantPremium,
        actorType: "customer",
        actorId: IDS.userPremiumOwner,
        action: "account.login_failed",
        ok: false,
        at: new Date("2026-01-11T00:00:00.000Z"),
        context: { method: "password" },
      }),
      // The one row anywhere with an email address — masked by the admin
      // read surface, never by the fixture (GRAFT-29.2 AC4/AC6).
      activityFixture(112, {
        action: "notify.email.sent",
        ok: true,
        at: new Date("2026-01-12T00:00:00.000Z"),
        context: {
          template: "welcome-email",
          to: "owner@qa-premium.test",
          messageId: "msg_qa_seed_abc",
        },
      }),
      activityFixture(113, {
        action: "notify.email.failed",
        ok: false,
        at: new Date("2026-01-13T00:00:00.000Z"),
        context: {
          template: "invoice-email",
          to: "owner@qa-premium.test",
          errorCode: "bounce",
        },
      }),
      activityFixture(114, {
        action: "billing.subscription.add",
        ok: true,
        at: new Date("2026-01-14T00:00:00.000Z"),
        context: { toTier: "premium", reason: "upgrade via checkout" },
      }),
      activityFixture(115, {
        action: "billing.payment.succeeded",
        ok: true,
        at: new Date("2026-01-15T00:00:00.000Z"),
        context: { amountCents: 2900, currency: "usd" },
      }),
      activityFixture(117, {
        tenantId: IDS.tenantPremium,
        actorType: "customer",
        actorId: IDS.userPremiumOwner,
        action: "entity.created",
        ok: true,
        at: new Date("2026-01-16T00:00:00.000Z"),
        context: {
          entityDefId: IDS.entityPremiumCustomers.toHexString(),
          entityType: "customers",
          recordId: "0000000000000000000000ff",
        },
      }),
      // A different tenant, so the `tenantId` filter (AC2) has something real
      // to exclude.
      activityFixture(116, {
        tenantId: IDS.tenantFree,
        actorType: "customer",
        actorId: IDS.userFreeOwner,
        action: "account.signup",
        ok: true,
        at: new Date("2026-01-05T00:00:00.000Z"),
        context: { method: "password" },
      }),
    ]);

    const counts = await Promise.all(
      COLLECTIONS.map(
        async (name) => [name, await db.collection(name).countDocuments()] as const,
      ),
    );
    console.log(`[graft] qa fixtures loaded into '${db.databaseName}' (period ${PERIOD})`);
    for (const [name, count] of counts)
      if (count) console.log(`  ${String(count).padStart(4)}  ${name}`);
    console.log(
      "        tenants: qa-free · qa-premium · qa-at-quota (at hard stop) · qa-downgraded (read-only over-limit)",
    );
    console.log(
      "        qa-override is MUTATED by bruno/admin/tenant-tier-override*.bru — re-seed before every run",
    );
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("[graft] qa seed failed:", error);
  process.exit(1);
});
