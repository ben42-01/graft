/**
 * GET /f/[tenantSlug]/[formSlug] (GRAFT-10) — the shareable advert
 * (docs/Graft.md §4.4). Server-rendered, no cookie read, no authenticated
 * bundle (AC7): everything on this page comes from `getPublicFormPage`,
 * which is the same kind of unauthenticated lookup GRAFT-09's submit path
 * already does.
 *
 * 200 for a published+enabled form, 404 — via `notFound()` — for unknown,
 * unpublished or killed alike (AC1, same collapse GRAFT-09 uses for AC9).
 */
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { FormCarousel } from "@/components/public-form/form-carousel";
import { PublicFormShell } from "@/components/public-form/public-form-shell";
import { PublicFormRenderer } from "@/components/public-form/public-form-renderer";
import { buildFormOgMetadata, getPublicFormPage } from "@/server/services/public-form-page";

export const dynamic = "force-dynamic";

type Params = { tenantSlug: string; formSlug: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { tenantSlug, formSlug } = await params;
  const page = await getPublicFormPage(tenantSlug, formSlug);
  if (!page) return {};

  const { title, description } = buildFormOgMetadata(page);
  return {
    title,
    description,
    openGraph: { title, description, type: "website" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function PublicFormPage({ params }: { params: Promise<Params> }) {
  const { tenantSlug, formSlug } = await params;
  const page = await getPublicFormPage(tenantSlug, formSlug);
  if (!page) notFound();

  return (
    <PublicFormShell
      tenantName={page.tenantName}
      logoUrl={page.branding.logoUrl}
      accent={page.branding.primaryColor}
      title={page.formName}
      wide={page.catalogue !== null}
      showBadge={page.showBadge}
    >
      {/* Above the fields, not below: the hero image is what makes a shared
       * link read as an advert, and a visitor who has to scroll past a form to
       * see what is being offered has already been asked for their details. */}
      <FormCarousel images={page.carousel} />

      {/* Only the catalogue's shape is passed; the records themselves are
       * fetched a page at a time by the client, so a business with ten
       * thousand products does not put ten thousand products in this HTML. */}
      <PublicFormRenderer
        tenantSlug={page.tenantSlug}
        formSlug={page.formSlug}
        fields={page.fields}
        primaryColor={page.branding.primaryColor}
        catalogue={
          page.catalogue
            ? { selectionKey: page.catalogue.selectionKey, multiple: page.catalogue.multiple }
            : null
        }
        cartPricing={page.booking}
        timeFields={page.timeFields}
        content={page.content}
      />
    </PublicFormShell>
  );
}
