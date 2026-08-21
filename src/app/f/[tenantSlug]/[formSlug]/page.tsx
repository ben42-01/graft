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
import Link from "next/link";
import type { Metadata } from "next";
import { PoweredByBadge } from "@/components/public-form/powered-by-badge";
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
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center gap-6 px-4 py-12">
      <header className="flex flex-col items-center gap-3 text-center">
        {page.branding.logoUrl ? (
          // A tenant-hosted logo URL, not a project asset next/image's loader
          // can optimise — next/image would require allow-listing every
          // possible tenant's image host in next.config.
          <img
            src={page.branding.logoUrl}
            alt={`${page.tenantName} logo`}
            className="h-12 w-auto"
          />
        ) : null}
        <h1 className="text-2xl font-semibold tracking-tight">{page.formName}</h1>
      </header>

      <PublicFormRenderer
        tenantSlug={page.tenantSlug}
        formSlug={page.formSlug}
        fields={page.fields}
        primaryColor={page.branding.primaryColor}
      />

      {/* The badge is Free-only (AC5), so it cannot carry the privacy link:
       * someone handing over their details to a Premium tenant's form needs
       * that link just as much. The footer is therefore always rendered,
       * and the badge is what varies inside it. */}
      <footer className="flex items-center justify-center gap-3 text-xs text-muted-foreground">
        {page.showBadge ? <PoweredByBadge /> : null}
        <Link href="/privacy" className="hover:text-foreground">
          Privacy
        </Link>
      </footer>
    </main>
  );
}
