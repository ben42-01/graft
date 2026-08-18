/**
 * The plugin manifest type and the first-party catalog (GRAFT-14,
 * docs/Graft.md §4.1).
 *
 * A plugin is described *entirely* by its manifest (AC1) — the framework is
 * what matters, not the three MVP plugins it ships with, because it decides
 * whether a third-party plugin is possible in Phase 3 without a rewrite
 * (Context). This module only ever produces data: nothing here executes
 * plugin-supplied code, which is a Phase 3 SDK decision with its own threat
 * model (Constraints), not something this issue may pre-empt.
 *
 * Only the three MVP plugins (Contacts, Forms, Scheduling) declare `entities`
 * and `forms` — those are what src/server/services/plugins.ts provisions on
 * activation (AC1, AC7). The rest of docs/Graft.md §4.1's initial catalog is
 * still listed, with empty `entities`/`forms`, so `GET /api/v1/plugins` and
 * tier-gating (AC4) are real against the whole catalog rather than only the
 * three plugins this issue happens to provision — building their capability
 * is explicitly out of scope (Premium plugins, the marketplace) and stays
 * that way; only the catalog entry is data.
 */
import { z } from "zod";
import { TIERS, type Tier } from "@/server/tiers";
import { fieldDefSchema, type FieldDef } from "@/server/services/entities";

export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
/** Same alphabet entities.ts's `identifier` field-key validator uses — a
 * manifest entity/field key ends up in the same Mongo path a manual
 * createEntity call would produce. */
const identifierPattern = /^[a-z][a-z0-9_]*$/;
/** Same alphabet forms.ts's `formSlugSchema` uses. */
const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A field the plugin's default entity carries — the same shape entities.ts
 * validates a manual `createEntity` call against, so a manifest entity is
 * never a second definition of what a valid field is. */
export type PluginEntityDef = {
  key: string;
  name: string;
  fields: FieldDef[];
};

/** A default form the plugin provisions, bound to one of its own entities by
 * key. `fields` names entity field keys, the same contract createForm takes. */
export type PluginFormDef = {
  key: string;
  name: string;
  slug: string;
  visibility: "internal" | "public";
  entityKey: string;
  fields: string[];
};

export type PluginManifest = {
  id: string;
  name: string;
  version: string;
  entities: readonly PluginEntityDef[];
  forms: readonly PluginFormDef[];
  /** Dashboard components the plugin contributes (docs/Graft.md §4.3).
   * Declarative catalog data in the MVP — nothing here provisions a widget
   * or registers it with src/lib/widgets/registry.tsx; that is a dashboard
   * concern, not a plugin-activation one. */
  widgets: readonly string[];
  /** Tenant-workspace pages the plugin adds. Declarative catalog data in the
   * MVP — no route is actually mounted by enabling a plugin. */
  routes: readonly string[];
  /**
   * Declared-but-not-yet-enforced (GRAFT-14 AC5 — dropped from this issue's
   * scope, see issue #18): data only, the same treatment `routes`/`widgets`
   * get. There is no RBAC registry and nothing calls `assertPermission` on
   * these; do not treat this field as a working access gate.
   */
  permissions: readonly string[];
  tier: Tier;
};

const contacts: PluginManifest = {
  id: "contacts",
  name: "Contacts",
  version: "1.0.0",
  entities: [
    {
      key: "contacts",
      name: "Contacts",
      fields: [
        { key: "name", label: "Name", type: "text", required: true },
        { key: "email", label: "Email", type: "email", required: false },
        { key: "phone", label: "Phone", type: "phone", required: false },
      ],
    },
  ],
  forms: [
    {
      key: "contacts-form",
      name: "Contacts",
      slug: "contacts-form",
      visibility: "internal",
      entityKey: "contacts",
      fields: ["name", "email", "phone"],
    },
  ],
  widgets: ["record_list"],
  routes: ["/contacts"],
  permissions: [],
  tier: "free",
};

const formsPlugin: PluginManifest = {
  id: "forms",
  name: "Forms",
  version: "1.0.0",
  entities: [
    {
      key: "inquiries",
      name: "Inquiries",
      fields: [
        { key: "name", label: "Name", type: "text", required: true },
        { key: "email", label: "Email", type: "email", required: true },
        { key: "message", label: "Message", type: "text", required: false },
      ],
    },
  ],
  forms: [
    {
      key: "inquiries-form",
      name: "Inquiries",
      slug: "inquiries-form",
      visibility: "internal",
      entityKey: "inquiries",
      fields: ["name", "email", "message"],
    },
  ],
  widgets: ["record_list"],
  routes: ["/forms"],
  permissions: [],
  tier: "free",
};

const scheduling: PluginManifest = {
  id: "scheduling",
  name: "Scheduling",
  version: "1.0.0",
  entities: [
    {
      key: "appointments",
      name: "Appointments",
      fields: [
        { key: "customer_name", label: "Customer name", type: "text", required: true },
        { key: "scheduled_at", label: "Scheduled at", type: "date", required: true },
        { key: "notes", label: "Notes", type: "text", required: false },
      ],
    },
  ],
  forms: [
    {
      key: "booking-request",
      name: "Booking Request",
      slug: "booking-request",
      visibility: "internal",
      entityKey: "appointments",
      fields: ["customer_name", "scheduled_at", "notes"],
    },
  ],
  widgets: ["calendar"],
  routes: ["/scheduling"],
  permissions: [],
  tier: "free",
};

/** Catalog-only entries (docs/Graft.md §4.1) — Premium/Enterprise capability
 * is out of scope for this issue; these exist so the catalog endpoint and
 * tier-gating (AC4) are real, not so their features work. */
const invoicing: PluginManifest = {
  id: "invoicing",
  name: "Invoicing",
  version: "0.0.0",
  entities: [],
  forms: [],
  widgets: [],
  routes: [],
  permissions: [],
  tier: "premium",
};

const inventory: PluginManifest = {
  id: "inventory",
  name: "Inventory",
  version: "0.0.0",
  entities: [],
  forms: [],
  widgets: [],
  routes: [],
  permissions: [],
  tier: "premium",
};

const reports: PluginManifest = {
  id: "reports",
  name: "Reports",
  version: "0.0.0",
  entities: [],
  forms: [],
  widgets: [],
  routes: [],
  permissions: [],
  tier: "premium",
};

const automations: PluginManifest = {
  id: "automations",
  name: "Automations",
  version: "0.0.0",
  entities: [],
  forms: [],
  widgets: [],
  routes: [],
  permissions: [],
  tier: "premium",
};

const teamRoles: PluginManifest = {
  id: "team-roles",
  name: "Team & Roles",
  version: "0.0.0",
  entities: [],
  forms: [],
  widgets: [],
  routes: [],
  // Illustrative only (see the `permissions` field's doc comment above) — the
  // one plugin in the initial catalog with an obvious permission vocabulary,
  // and still enforced by nothing.
  permissions: ["team:manage"],
  tier: "premium",
};

const apiAccess: PluginManifest = {
  id: "api-access",
  name: "API Access / Webhooks",
  version: "0.0.0",
  entities: [],
  forms: [],
  widgets: [],
  routes: [],
  permissions: [],
  tier: "enterprise",
};

const whiteLabeling: PluginManifest = {
  id: "white-labeling",
  name: "White-labeling & SSO",
  version: "0.0.0",
  entities: [],
  forms: [],
  widgets: [],
  routes: [],
  permissions: [],
  tier: "enterprise",
};

/** First-party plugins, loaded at module scope — Phase 3's third-party
 * loading (Constraints: out of scope, do not foreclose) is a different
 * function with a different threat model, not a code path through here. */
export const PLUGIN_REGISTRY: readonly PluginManifest[] = [
  contacts,
  formsPlugin,
  scheduling,
  invoicing,
  inventory,
  reports,
  automations,
  teamRoles,
  apiAccess,
  whiteLabeling,
];

/** The three MVP plugins (Context) — every other entry is catalog-only. */
export const MVP_PLUGIN_IDS: readonly string[] = ["contacts", "forms", "scheduling"];

export function findPlugin(pluginId: string): PluginManifest | undefined {
  return PLUGIN_REGISTRY.find((p) => p.id === pluginId);
}

const TIER_RANK: Record<Tier, number> = { free: 0, premium: 1, enterprise: 2 };

/** AC4 — a tenant may enable a plugin at or below its own tier. */
export function tierEligible(tenantTier: Tier, pluginTier: Tier): boolean {
  return TIER_RANK[tenantTier] >= TIER_RANK[pluginTier];
}

/**
 * Manifest validation (Test Contract — "unit: manifest validation"). A
 * plugin's `entities`/`forms` reuse the exact key and field shapes
 * entities.ts/forms.ts already validate a manual create call against, so a
 * malformed manifest is caught here rather than surfacing as a confusing
 * VALIDATION_FAILED from inside provisioning.
 */
const pluginEntityDefSchema = z.object({
  key: z.string().regex(identifierPattern).max(64),
  name: z.string().trim().min(1).max(120),
  fields: z.array(fieldDefSchema).min(1).max(100),
});

const pluginFormDefSchema = z.object({
  key: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  slug: z.string().regex(slugPattern).max(64),
  visibility: z.enum(["internal", "public"]),
  entityKey: z.string().regex(identifierPattern).max(64),
  fields: z.array(z.string().regex(identifierPattern)).min(1).max(100),
});

export const pluginManifestSchema = z
  .object({
    id: z.string().regex(PLUGIN_ID_PATTERN).max(64),
    name: z.string().trim().min(1).max(120),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, "Expected semver x.y.z"),
    entities: z.array(pluginEntityDefSchema),
    forms: z.array(pluginFormDefSchema),
    widgets: z.array(z.string()),
    routes: z.array(z.string()),
    permissions: z.array(z.string()),
    tier: z.enum(TIERS),
  })
  .superRefine((manifest, ctx) => {
    // AC1, AC7 — a form can only bind to an entity the same manifest declares.
    const entityKeys = new Set(manifest.entities.map((e) => e.key));
    manifest.forms.forEach((form, i) => {
      if (!entityKeys.has(form.entityKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Form "${form.key}" binds to entity "${form.entityKey}", which this manifest does not declare`,
          path: ["forms", i, "entityKey"],
        });
      }
    });
  });

/** Every registered manifest must itself be valid data — a broken first-party
 * manifest is a build-time bug, not something a tenant should ever see. */
for (const manifest of PLUGIN_REGISTRY) {
  pluginManifestSchema.parse(manifest);
}
