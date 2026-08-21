/**
 * The entity template library — ready-made entity shapes a user can start
 * from instead of inventing fields on a blank form.
 *
 * Each template is one JSON file in `./templates`, deliberately: they are
 * content, not code. A JSON file has no imports and no logic, so it can be
 * reviewed by someone who doesn't read TypeScript, generated, or later
 * served from somewhere else (a paid pack, a per-industry set) without any
 * consumer of this module changing. The only thing this file adds is the
 * explicit import list — a bundler cannot glob a directory, and an explicit
 * list is also what keeps a half-finished draft out of the product.
 *
 * `templates.test.ts` validates every one of them against the same rules
 * `createEntitySchema` applies server-side, so a malformed template fails
 * the build rather than a user's "Create entity" click.
 *
 * Adding one: write `templates/<id>.json`, import it below, add it to
 * `ENTITY_TEMPLATES`. The test will tell you if the JSON is wrong.
 */
import assets from "./templates/assets.json";
import bookings from "./templates/bookings.json";
import customers from "./templates/customers.json";
import deals from "./templates/deals.json";
import employees from "./templates/employees.json";
import expenses from "./templates/expenses.json";
import invoices from "./templates/invoices.json";
import jobs from "./templates/jobs.json";
import leads from "./templates/leads.json";
import products from "./templates/products.json";
import projects from "./templates/projects.json";
import suppliers from "./templates/suppliers.json";
import tasks from "./templates/tasks.json";
import tickets from "./templates/tickets.json";
import timeEntries from "./templates/time_entries.json";

export type TemplateField = {
  key: string;
  label: string;
  type: string;
  required: boolean;
  options?: string[];
};

export type EntityTemplate = {
  id: string;
  name: string;
  category: string;
  description: string;
  entity: { key: string; name: string; fields: TemplateField[] };
};

/** Display order within the templates gallery: the categories a small
 * business meets first, in the order they usually meet them. */
export const TEMPLATE_CATEGORIES = [
  "Sales & CRM",
  "Operations",
  "Finance",
  "Inventory",
  "People",
  "Support",
] as const;

export const ENTITY_TEMPLATES: EntityTemplate[] = [
  customers,
  leads,
  deals,
  jobs,
  bookings,
  projects,
  tasks,
  invoices,
  expenses,
  products,
  suppliers,
  assets,
  employees,
  timeEntries,
  tickets,
];

export function findTemplate(id: string): EntityTemplate | undefined {
  return ENTITY_TEMPLATES.find((template) => template.id === id);
}

/** Templates grouped for rendering, in `TEMPLATE_CATEGORIES` order. Any
 * category not in that list still renders, after the known ones, rather than
 * silently hiding a template someone added. */
export function templatesByCategory(): { category: string; templates: EntityTemplate[] }[] {
  const known = TEMPLATE_CATEGORIES as readonly string[];
  const categories = [
    ...known,
    ...[...new Set(ENTITY_TEMPLATES.map((t) => t.category))].filter((c) => !known.includes(c)),
  ];

  return categories
    .map((category) => ({
      category,
      templates: ENTITY_TEMPLATES.filter((template) => template.category === category),
    }))
    .filter((group) => group.templates.length > 0);
}
