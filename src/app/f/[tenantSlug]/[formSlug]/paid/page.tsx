/**
 * GET /f/[tenantSlug]/[formSlug]/paid — where Stripe Checkout sends a visitor
 * back after paying on a form in checkout mode (stripe-connect.ts).
 *
 * It asserts nothing about the payment. Anyone can open this URL, so it reads
 * no session id and marks nothing paid; the Connect webhook is the only thing
 * that records money on an order. This page only thanks the visitor, in the
 * business's own frame, and 404s exactly where the form itself would.
 */
import { notFound } from "next/navigation";
import { CheckIcon } from "lucide-react";
import { PublicFormShell } from "@/components/public-form/public-form-shell";
import { GRAFT_ACCENT, contrastingTextColor } from "@/lib/contrast";
import { getPublicFormPage } from "@/server/services/public-form-page";

export const dynamic = "force-dynamic";

type Params = { tenantSlug: string; formSlug: string };

export const metadata = { robots: { index: false } };

export default async function PublicFormPaidPage({ params }: { params: Promise<Params> }) {
  const { tenantSlug, formSlug } = await params;
  const page = await getPublicFormPage(tenantSlug, formSlug);
  if (!page) notFound();

  const accent = page.branding.primaryColor ?? GRAFT_ACCENT;
  return (
    <PublicFormShell
      tenantName={page.tenantName}
      logoUrl={page.branding.logoUrl}
      accent={page.branding.primaryColor}
      title={page.formName}
      showBadge={page.showBadge}
    >
      <div role="status" className="flex flex-col items-center gap-3 py-6 text-center">
        <span
          className="flex size-12 items-center justify-center rounded-full"
          style={{ backgroundColor: accent, color: contrastingTextColor(accent) }}
          aria-hidden="true"
        >
          <CheckIcon className="size-6" />
        </span>
        <p className="text-lg font-semibold">Thank you — your payment went through.</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Stripe will email your receipt. {page.tenantName} will be in touch to confirm the
          details.
        </p>
      </div>
    </PublicFormShell>
  );
}
