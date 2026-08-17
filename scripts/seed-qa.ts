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
import { billingPeriod } from "../src/server/services/meters";
import { hashRefreshToken, REFRESH_TTL_SECONDS } from "../src/server/auth/refresh-tokens";
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

const oid = (n: number) => new ObjectId(n.toString(16).padStart(24, "0"));

const IDS = {
  tenantFree: oid(1),
  tenantPremium: oid(2),
  tenantAtQuota: oid(3),
  tenantDowngraded: oid(4),
  userFreeOwner: oid(11),
  userPremiumOwner: oid(12),
  userPremiumMember: oid(13),
  userAtQuotaOwner: oid(14),
  userDowngradedOwner: oid(15),
  // GRAFT-03.2 fixtures. New ids rather than edits to the five above, so every
  // assertion written against those still holds exactly as it did.
  userTwoTenants: oid(16),
  userUnverified: oid(17),
  entityFreeCustomers: oid(21),
  entityPremiumCustomers: oid(22),
  entityDowngradedExtra: oid(23),
  formFreePublic: oid(31),
  formAtQuota: oid(32),
  formDowngradedUnpublished: oid(33),
  recordFreeFirst: oid(41),
} as const;

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
        name: "QA Public Form",
        slug: "qa-public-form",
        publicSlug: "qa-free/qa-public-form",
        visibility: "public",
        published: true,
        fields: CUSTOMER_FIELDS,
        ...base,
      },
      {
        _id: IDS.formAtQuota,
        tenantId: IDS.tenantAtQuota,
        name: "QA Quota Form",
        slug: "qa-quota-form",
        publicSlug: "qa-at-quota/qa-quota-form",
        visibility: "public",
        published: true,
        fields: CUSTOMER_FIELDS,
        ...base,
      },
      {
        _id: IDS.formDowngradedUnpublished,
        tenantId: IDS.tenantDowngraded,
        name: "QA Unpublished Form",
        slug: "qa-unpublished-form",
        publicSlug: "qa-downgraded/qa-unpublished-form",
        visibility: "public",
        published: false, // unpublished by downgrade, data retained
        fields: CUSTOMER_FIELDS,
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
    ]);

    await db.collection("dashboards").insertOne({
      _id: oid(71),
      tenantId: IDS.tenantFree,
      ownerId: IDS.userFreeOwner,
      name: "QA Dashboard",
      widgets: [{ type: "table", title: "Customers", config: { entityKey: "customers" } }],
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
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("[graft] qa seed failed:", error);
  process.exit(1);
});
