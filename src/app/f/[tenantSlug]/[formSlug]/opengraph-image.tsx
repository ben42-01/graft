/**
 * AC4 — the OG image itself. A Next.js file-convention route: placed beside
 * `page.tsx`, its output is wired into that page's `og:image`/`twitter:image`
 * meta tags automatically, no manual `<meta>` needed here.
 *
 * Runs on the default (Node) runtime, not edge — `getPublicFormPage` goes
 * through the MongoDB driver, which edge can't load.
 */
import { ImageResponse } from "next/og";
import { getPublicFormPage } from "@/server/services/public-form-page";
import { contrastingTextColor } from "@/lib/contrast";

export const alt = "Graft form";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

type Params = { tenantSlug: string; formSlug: string };

export default async function Image({ params }: { params: Params }) {
  const page = await getPublicFormPage(params.tenantSlug, params.formSlug);

  const background = page?.branding.primaryColor ?? "#111827";
  const foreground = contrastingTextColor(background);
  const headline = page ? page.formName : "Form not found";
  const subhead = page ? `Shared by ${page.tenantName} on Graft` : "";

  return new ImageResponse(
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 24,
        backgroundColor: background,
        color: foreground,
        fontSize: 64,
        fontWeight: 600,
        textAlign: "center",
        padding: 80,
      }}
    >
      {page?.branding.logoUrl ? (
        <img src={page.branding.logoUrl} alt="" width={96} height={96} />
      ) : null}
      <div>{headline}</div>
      {subhead ? <div style={{ fontSize: 32, fontWeight: 400 }}>{subhead}</div> : null}
    </div>,
    { ...size },
  );
}
