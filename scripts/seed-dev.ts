/**
 * Development seed — a believable multi-tenant world (docs/WORKFLOW.md §5.1).
 *
 * Generative (faker) and deliberately messy: realistic volumes, meters parked
 * near tier thresholds so 80% warnings and hard stops are exercisable by hand.
 * QA gets the deterministic version — see seed-qa.ts.
 *
 * Idempotent by seedBatch: re-running replaces prior seed data only, so hand-made
 * local records survive a reseed.
 */
import { faker } from "@faker-js/faker";
import { ObjectId, type Db } from "mongodb";
import { connect, COLLECTIONS } from "./lib/db";
import { TIER_LIMITS, type Tier } from "../src/server/tiers";
import { billingPeriod } from "../src/server/services/meters";
import { hashPassword } from "../src/server/auth/passwords";

/** Every dev tenant renews on the 1st, so the meter period is the calendar month. */
const BILLING_ANCHOR_DAY = 1;

const SEED_BATCH = "dev-seed";
const DEV_PASSWORD = "Dev!12345678"; // >= PASSWORD_MIN_LENGTH (GRAFT-03.2 AC4)

faker.seed(42); // stable-ish between runs; still generative in shape

type TenantSpec = {
  name: string;
  slug: string;
  tier: Tier;
  industry: string;
  entities: { key: string; name: string; fields: EntityField[]; records: number }[];
  forms: { name: string; slug: string; submissions: number }[];
  /** fraction of the submission quota already consumed this period */
  meterFill: number;
};

type EntityField = {
  key: string;
  label: string;
  type: "text" | "number" | "date" | "select" | "checkbox" | "email" | "phone";
  required?: boolean;
  options?: string[];
};

const CONTACT_FIELDS: EntityField[] = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "email", label: "Email", type: "email" },
  { key: "phone", label: "Phone", type: "phone" },
  { key: "notes", label: "Notes", type: "text" },
];

const JOB_FIELDS: EntityField[] = [
  { key: "title", label: "Job title", type: "text", required: true },
  { key: "status", label: "Status", type: "select", options: ["quoted", "scheduled", "done"] },
  { key: "scheduledFor", label: "Scheduled for", type: "date" },
  { key: "value", label: "Value (minor units)", type: "number" },
  { key: "urgent", label: "Urgent", type: "checkbox" },
];

const TENANTS: TenantSpec[] = [
  {
    name: "Bella's Barbershop",
    slug: "bellas-barbershop",
    tier: "free",
    industry: "Personal care",
    entities: [
      { key: "customers", name: "Customers", fields: CONTACT_FIELDS, records: 120 },
      { key: "bookings", name: "Bookings", fields: JOB_FIELDS, records: 260 },
    ],
    forms: [{ name: "Book a cut", slug: "book-a-cut", submissions: 80 }],
    meterFill: 0.85, // just past the 80% warning — free tier, 100/mo
  },
  {
    name: "O'Shea Plumbing",
    slug: "oshea-plumbing",
    tier: "premium",
    industry: "Trades & services",
    entities: [
      { key: "customers", name: "Customers", fields: CONTACT_FIELDS, records: 480 },
      { key: "jobs", name: "Jobs", fields: JOB_FIELDS, records: 500 },
      { key: "quotes", name: "Quotes", fields: JOB_FIELDS, records: 200 },
    ],
    forms: [
      { name: "Request a quote", slug: "request-a-quote", submissions: 200 },
      { name: "Emergency callout", slug: "emergency-callout", submissions: 60 },
    ],
    meterFill: 0.4,
  },
  {
    name: "Shannon Logistics",
    slug: "shannon-logistics",
    tier: "enterprise",
    industry: "Transport & logistics",
    entities: [
      { key: "clients", name: "Clients", fields: CONTACT_FIELDS, records: 300 },
      { key: "consignments", name: "Consignments", fields: JOB_FIELDS, records: 500 },
    ],
    forms: [{ name: "Book a collection", slug: "book-a-collection", submissions: 150 }],
    meterFill: 0.1,
  },
];

const PLUGINS_BY_TIER: Record<Tier, string[]> = {
  free: ["contacts", "forms", "scheduling"],
  premium: ["contacts", "forms", "scheduling", "invoicing", "reports", "automations"],
  enterprise: ["contacts", "forms", "scheduling", "invoicing", "reports", "automations", "api"],
};

function recordData(fields: EntityField[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    switch (field.type) {
      case "text":
        data[field.key] =
          field.key === "name" ? faker.person.fullName() : faker.lorem.sentence();
        break;
      case "email":
        data[field.key] = faker.internet.email().toLowerCase();
        break;
      case "phone":
        data[field.key] = faker.phone.number();
        break;
      case "number":
        data[field.key] = faker.number.int({ min: 2_500, max: 250_000 });
        break;
      case "date":
        data[field.key] = faker.date.soon({ days: 60 });
        break;
      case "select":
        data[field.key] = faker.helpers.arrayElement(field.options ?? ["a", "b"]);
        break;
      case "checkbox":
        data[field.key] = faker.datatype.boolean({ probability: 0.2 });
        break;
    }
  }
  return data;
}

async function clearPreviousBatch(db: Db) {
  let removed = 0;
  for (const name of COLLECTIONS) {
    const result = await db.collection(name).deleteMany({ seedBatch: SEED_BATCH });
    removed += result.deletedCount;
  }
  if (removed) console.log(`  − removed ${removed} documents from the previous ${SEED_BATCH}`);
}

async function main() {
  const { client, db } = await connect();
  // Anchored on the 1st, like the seeded tenants, so the period the app
  // computes at request time is the one seeded here (GRAFT-05 AC6).
  const period = billingPeriod(BILLING_ANCHOR_DAY, new Date());

  try {
    await clearPreviousBatch(db);

    for (const spec of TENANTS) {
      const tenantId = new ObjectId();
      const limits = TIER_LIMITS[spec.tier];
      const stamp = { seedBatch: SEED_BATCH, createdAt: new Date(), updatedAt: new Date() };

      await db.collection("tenants").insertOne({
        _id: tenantId,
        name: spec.name,
        slug: spec.slug,
        tier: spec.tier,
        industry: spec.industry,
        limits,
        billingAnchorDay: BILLING_ANCHOR_DAY,
        branding: { logoUrl: null, primaryColor: faker.color.rgb() },
        settings: { currency: "EUR", timezone: "Europe/Dublin", locale: "en-IE" },
        ...stamp,
      });

      // Owner/admin/member — the seat count still respects the tier
      const roles = spec.tier === "free" ? ["owner"] : ["owner", "admin", "member"];
      // Hashed once per tenant rather than per user — argon2id is intentionally
      // slow and every seeded account shares DEV_PASSWORD anyway.
      const passwordHash = await hashPassword(DEV_PASSWORD);
      await db.collection("users").insertMany(
        roles.map((role) => ({
          _id: new ObjectId(),
          email: `${role}@${spec.slug}.test`,
          name: faker.person.fullName(),
          // AC4 — a real argon2id digest, not a placeholder. The dev seed now
          // produces accounts that can actually sign in through /auth/login.
          passwordHash,
          emailVerifiedAt: new Date(),
          memberships: [{ tenantId, roles: [role] }],
          ...stamp,
        })),
      );

      await db.collection("plugins_enabled").insertMany(
        PLUGINS_BY_TIER[spec.tier].map((pluginId) => ({
          _id: new ObjectId(),
          tenantId,
          pluginId,
          config: {},
          enabledAt: new Date(),
          ...stamp,
        })),
      );

      for (const entity of spec.entities) {
        const entityDefId = new ObjectId();
        await db.collection("entity_defs").insertOne({
          _id: entityDefId,
          tenantId,
          key: entity.key,
          name: entity.name,
          fields: entity.fields,
          schemaVersion: 1,
          ...stamp,
        });

        const rows = Array.from({ length: entity.records }, () => ({
          _id: new ObjectId(),
          tenantId,
          entityDefId,
          schemaVersion: 1,
          data: recordData(entity.fields),
          deletedAt: null,
          createdAt: faker.date.recent({ days: 180 }),
          updatedAt: new Date(),
          seedBatch: SEED_BATCH,
        }));
        await db.collection("records").insertMany(rows);
      }

      for (const form of spec.forms) {
        const formId = new ObjectId();
        await db.collection("forms").insertOne({
          _id: formId,
          tenantId,
          name: form.name,
          slug: form.slug,
          publicSlug: `${spec.slug}/${form.slug}`,
          visibility: "public",
          published: true,
          fields: CONTACT_FIELDS,
          ...stamp,
        });

        await db.collection("form_submissions").insertMany(
          Array.from({ length: form.submissions }, () => ({
            _id: new ObjectId(),
            tenantId,
            formId,
            data: recordData(CONTACT_FIELDS),
            spamScore: faker.number.float({ min: 0, max: 0.3, fractionDigits: 2 }),
            countedTowardQuota: true,
            createdAt: faker.date.recent({ days: 30 }),
            seedBatch: SEED_BATCH,
          })),
        );
      }

      // Meters parked near the threshold so upgrade prompts are visible in dev
      const cap = limits.submissionsPerMonth;
      await db.collection("usage_meters").insertOne({
        _id: new ObjectId(),
        tenantId,
        meter: "form_submissions",
        period,
        count: cap ? Math.round(cap * spec.meterFill) : 1_200,
        ...stamp,
      });

      await db.collection("dashboards").insertOne({
        _id: new ObjectId(),
        tenantId,
        ownerId: null,
        name: "Home",
        widgets: [
          {
            type: "kpi",
            title: "Submissions this month",
            config: { meter: "form_submissions" },
          },
          {
            type: "table",
            title: spec.entities[0].name,
            config: { entityKey: spec.entities[0].key },
          },
          { type: "calendar", title: "Week", config: {} },
        ],
        ...stamp,
      });

      const totalRecords = spec.entities.reduce((sum, e) => sum + e.records, 0);
      console.log(
        `  ✓ ${spec.name} (${spec.tier}) — ${spec.entities.length} entities, ${totalRecords} records, ${spec.forms.length} form(s)`,
      );
    }

    console.log(`\n[graft] dev seed complete on '${db.databaseName}'`);
    console.log(`        sign in as owner@<tenant-slug>.test — password: ${DEV_PASSWORD}`);
    console.log(
      `        e.g. owner@bellas-barbershop.test (free tier, 85% of submission quota)\n`,
    );
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("[graft] dev seed failed:", error);
  process.exit(1);
});
