/**
 * Onboarding wizard step + starter-template data (GRAFT-12, docs/Graft.md §3).
 *
 * Deliberately dependency-free (no `mongodb`, no server-only imports) so the
 * same module is importable from both the client wizard
 * (`src/app/(app)/onboarding/page.tsx`) and the server state service
 * (`src/server/services/onboarding.ts`) without pulling server code into the
 * browser bundle. Field shapes here are a subset of `FieldDef`
 * (`src/server/services/entities.ts`) — every field this file describes is
 * valid input to `createEntitySchema` as-is.
 */

export const ONBOARDING_STEPS = [
  "profile",
  "template",
  "plugins",
  "entity",
  "form",
  "dashboard",
  "done",
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const STEP_LABELS: Record<OnboardingStep, string> = {
  profile: "Business profile",
  template: "Template",
  plugins: "Plugins",
  entity: "First entity",
  form: "First form",
  dashboard: "Dashboard",
  done: "Done",
};

export type TemplateField = {
  key: string;
  label: string;
  type: "text" | "email" | "phone";
  required: boolean;
};

export type StarterTemplate = {
  id: string;
  label: string;
  /** Values the profile step's industry select offers that map to this
   * template (AC3). */
  industries: readonly string[];
  pluginIds: readonly string[];
  entity: { key: string; name: string; fields: readonly TemplateField[] };
  form: { name: string; slug: string; fields: readonly string[] };
};

const contactFields: readonly TemplateField[] = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "email", label: "Email", type: "email", required: false },
  { key: "phone", label: "Phone", type: "phone", required: false },
];

/** The 3 starter templates in scope (the 5-8 template library is a separate
 * content issue, docs/GO-LIVE.md §7 🟡). Every entity key below ("customers")
 * is one none of the first-party plugins provisions (src/server/plugins.ts
 * uses "contacts"/"inquiries"/"appointments"), so accepting a template's
 * plugins and its guided entity in the same wizard run never collides. */
export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  {
    id: "trades-services",
    label: "Trades & Services",
    industries: ["trades"],
    pluginIds: ["contacts", "scheduling"],
    entity: { key: "customers", name: "Customers", fields: contactFields },
    form: { name: "Book a Job", slug: "book-a-job", fields: ["name", "email", "phone"] },
  },
  {
    id: "retail-ecommerce",
    label: "Retail & Ecommerce",
    industries: ["retail"],
    pluginIds: ["contacts", "forms"],
    entity: { key: "customers", name: "Customers", fields: contactFields },
    form: { name: "Contact Us", slug: "contact-us", fields: ["name", "email", "phone"] },
  },
  {
    id: "professional-services",
    label: "Professional Services",
    industries: ["professional"],
    pluginIds: ["contacts"],
    entity: { key: "customers", name: "Clients", fields: contactFields },
    form: {
      name: "Request a Consultation",
      slug: "request-a-consultation",
      fields: ["name", "email", "phone"],
    },
  },
];

/** The blank-canvas path (AC3) — no plugins pre-selected, a minimal entity and
 * form the user is expected to edit before submitting. */
export const BLANK_TEMPLATE: StarterTemplate = {
  id: "blank",
  label: "Start blank",
  industries: [],
  pluginIds: [],
  entity: {
    key: "customers",
    name: "Customers",
    fields: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "email", label: "Email", type: "email", required: false },
    ],
  },
  form: { name: "Contact Us", slug: "contact-us", fields: ["name", "email"] },
};

/** The industry options the profile step's select offers — every template's
 * industries plus "Other", which suggests nothing (AC3). */
export const INDUSTRY_OPTIONS: readonly { value: string; label: string }[] = [
  ...STARTER_TEMPLATES.map((template) => ({
    value: template.industries[0] ?? template.id,
    label: template.label,
  })),
  { value: "other", label: "Other" },
];

/** AC3 — the suggestion an industry maps to, or `null` for "Other"/unmapped,
 * which the wizard treats identically to explicitly choosing "start blank". */
export function suggestTemplate(industry: string): StarterTemplate | null {
  return STARTER_TEMPLATES.find((template) => template.industries.includes(industry)) ?? null;
}

export function findTemplate(templateId: string): StarterTemplate {
  if (templateId === BLANK_TEMPLATE.id) return BLANK_TEMPLATE;
  return STARTER_TEMPLATES.find((template) => template.id === templateId) ?? BLANK_TEMPLATE;
}
