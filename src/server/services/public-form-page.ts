/**
 * The public form page's read path (GRAFT-10, docs/Graft.md §4.4). Everything
 * the page and its OG image route need, in one lookup, kept separate from
 * `public-forms.ts` (GRAFT-09) because that module is a write path with its
 * own transaction — this one only ever reads and renders.
 *
 * Three things matter enough to call out:
 *
 *   - **Unknown, unpublished and killed all collapse to `null`.** Same
 *     precedent as GRAFT-09's `submitPublicForm`: the page 404s identically
 *     for all three (AC1), so a scraper can't distinguish "never existed"
 *     from "existed and got killed".
 *   - **The badge is tier-derived, not form-stored.** `forms.showBadge` is an
 *     always-true flag reserved for a future manual override; the actual
 *     Free/Premium split is `TIER_FEATURES[tier].remove_branding` (docs/TIERS.md
 *     §2.5, "Powered by Graft" row), decided here so the server — not the
 *     client — enforces AC5.
 *   - **No `Ctx` anywhere in this file.** Same reasoning as GRAFT-09's public
 *     path: there is no authenticated user to build one for, and this page
 *     must read no cookie (AC7).
 */
import {
  findByPublicSlug as findByPublicSlugDefault,
  formSlugSchema,
  toCarouselView,
  toCatalogueView,
  type CarouselItemView,
  type CatalogueView,
  type FormDoc,
} from "./forms";
import type { FieldDef } from "./entities";
import { isFormServable } from "./forms";
import {
  mongoAccountStore,
  type AccountStore,
  type TenantBranding,
} from "@/server/auth/accounts-store";
import { TIER_FEATURES } from "@/server/tiers";

export type PublicFormPageData = {
  formName: string;
  fields: FieldDef[];
  /** The form's own hero image; empty for most forms. */
  carousel: CarouselItemView[];
  /**
   * Catalogue mode's config, or `null`. Only the *shape* travels here — which
   * fields are public, whether there is a picture, how big a page is. The
   * records themselves come from `/api/v1/public/forms/.../catalogue`, one
   * page at a time, so this server component never renders an unbounded read
   * of tenant data into the initial HTML.
   */
  catalogue: CatalogueView | null;
  /**
   * The fields that carry a booking's start and end, if this form takes
   * bookings. Only the keys travel — the rate basis and the deposit are
   * pricing, and a public page has no business knowing them. The renderer
   * uses this to ask for a date *and a time*, because "the 20th" cannot
   * express a four-hour hire.
   */
  timeFields: string[];
  tenantName: string;
  tenantSlug: string;
  formSlug: string;
  branding: TenantBranding;
  showBadge: boolean;
};

export type PublicFormPageDeps = {
  findByPublicSlug: typeof findByPublicSlugDefault;
  accounts: AccountStore;
};

function resolveDeps(overrides: Partial<PublicFormPageDeps> = {}): PublicFormPageDeps {
  return {
    findByPublicSlug: overrides.findByPublicSlug ?? findByPublicSlugDefault,
    accounts: overrides.accounts ?? mongoAccountStore(),
  };
}

/** The booking config reduced to the only part a public page needs. */
export function bookingTimeFields(booking: FormDoc["booking"]): string[] {
  if (!booking) return [];
  return booking.endKey !== null ? [booking.startKey, booking.endKey] : [booking.startKey];
}

/** AC5 — server-decided, independent of anything the client sends. */
export function shouldShowBadge(
  form: { showBadge: boolean },
  tier: keyof typeof TIER_FEATURES,
): boolean {
  return form.showBadge && !TIER_FEATURES[tier].remove_branding;
}

/** AC4 — the OG title/description pair, kept pure so it's unit-testable
 * without a database. */
export function buildFormOgMetadata(input: { formName: string; tenantName: string }): {
  title: string;
  description: string;
} {
  return {
    title: `${input.formName} — ${input.tenantName}`,
    description: `Fill out ${input.formName}, shared by ${input.tenantName} on Graft.`,
  };
}

/**
 * AC1, AC9 (GRAFT-09's convention carried over) — a single lookup the page,
 * `generateMetadata` and the OG image route all call independently. Returns
 * `null` for unknown, unpublished, killed or malformed slugs alike.
 */
export async function getPublicFormPage(
  tenantSlug: string,
  formSlug: string,
  overrides: Partial<PublicFormPageDeps> = {},
): Promise<PublicFormPageData | null> {
  const deps = resolveDeps(overrides);

  const tenantParsed = formSlugSchema.safeParse(tenantSlug);
  const formParsed = formSlugSchema.safeParse(formSlug);
  if (!tenantParsed.success || !formParsed.success) return null;

  const form = await deps.findByPublicSlug(`${tenantParsed.data}/${formParsed.data}`);
  if (!form || !isFormServable(form)) return null;

  const tenant = await deps.accounts.findTenantById(form.tenantId.toHexString());
  if (!tenant) return null;

  const branding = tenant.branding ?? { logoUrl: null, primaryColor: null };

  return {
    formName: form.name,
    fields: form.fields,
    carousel: toCarouselView(form.carousel),
    catalogue: toCatalogueView(form.catalogue),
    timeFields: bookingTimeFields(form.booking),
    tenantName: tenant.name,
    tenantSlug: tenantParsed.data,
    formSlug: formParsed.data,
    branding,
    showBadge: shouldShowBadge(form, tenant.tier),
  };
}
