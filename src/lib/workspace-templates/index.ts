/**
 * The workspace template library — one-click business setups ("Graft Hotel",
 * "Graft Salon", …) that create a whole working workspace: the things a
 * business offers, where requests land, a public form wired to both, and the
 * booking, deposit, payment and terms decisions an owner makes as toggles.
 *
 * Same arrangement as `@/lib/entity-templates`: each template is a JSON file
 * (content, not code) and this module is the explicit import list. Unlike
 * that library the JSON is parsed through `workspaceTemplateSchema` on load,
 * so every consumer sees defaults filled in; `templates.test.ts` proves each
 * one resolves to inputs the real APIs accept under every combination of
 * answers.
 *
 * Adding one: write `templates/<id>.json`, import it below, add it to the
 * list. The tests will tell you what is wrong with it.
 */
import equipmentHire from "./templates/equipment-hire.json";
import fitnessStudio from "./templates/fitness-studio.json";
import hotel from "./templates/hotel.json";
import petCare from "./templates/pet-care.json";
import professionalServices from "./templates/professional-services.json";
import restaurant from "./templates/restaurant.json";
import salon from "./templates/salon.json";
import trades from "./templates/trades.json";
import vehicleRental from "./templates/vehicle-rental.json";
import venue from "./templates/venue.json";
import { workspaceTemplateSchema, type WorkspaceTemplate } from "./schema";

export const WORKSPACE_TEMPLATES: WorkspaceTemplate[] = [
  hotel,
  salon,
  fitnessStudio,
  equipmentHire,
  vehicleRental,
  venue,
  petCare,
  restaurant,
  trades,
  professionalServices,
].map((raw) => workspaceTemplateSchema.parse(raw));

export function findWorkspaceTemplate(id: string): WorkspaceTemplate | undefined {
  return WORKSPACE_TEMPLATES.find((template) => template.id === id);
}

/** What the gallery shows — everything but the blueprint's insides. */
export type WorkspaceTemplateSummary = Pick<
  WorkspaceTemplate,
  "id" | "name" | "tagline" | "description" | "icon" | "industry" | "highlights"
>;

export function summariseWorkspaceTemplate(
  template: WorkspaceTemplate,
): WorkspaceTemplateSummary {
  const { id, name, tagline, description, icon, industry, highlights } = template;
  return { id, name, tagline, description, icon, industry, highlights };
}

export * from "./resolve";
export * from "./schema";
