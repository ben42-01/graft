/**
 * The frame every public form page sits in — the form itself and its `/paid`
 * landing page alike. The business comes first (their logo, their name, their
 * colour on the card's top edge); Graft is the quiet backdrop: a soft green
 * wash behind a raised card, and the badge on Free.
 *
 * A server component with no state: the badge decision (AC5) was made by
 * `shouldShowBadge` before this renders, and the privacy link is always here,
 * since the badge is Free-only and a Premium tenant's visitors need it just as
 * much.
 */
import Link from "next/link";
import { PoweredByBadge } from "@/components/public-form/powered-by-badge";
import { GRAFT_ACCENT } from "@/lib/contrast";

export function PublicFormShell({
  tenantName,
  logoUrl,
  accent,
  title,
  wide = false,
  showBadge,
  children,
}: {
  tenantName: string;
  logoUrl: string | null;
  accent: string | null;
  title: string;
  /** A catalogue needs room for photos beside their details; a plain form
   * reads better narrow. */
  wide?: boolean;
  showBadge: boolean;
  children: React.ReactNode;
}) {
  const edge = accent ?? GRAFT_ACCENT;
  return (
    <div className="min-h-screen bg-linear-to-b from-graft-green/10 via-background to-background">
      <main
        className={`mx-auto flex min-h-screen w-full flex-col gap-6 px-4 py-10 sm:py-14 ${
          wide ? "max-w-2xl" : "max-w-lg"
        }`}
      >
        <header className="flex flex-col items-center gap-3 text-center">
          {logoUrl ? (
            // A tenant-hosted logo URL, not a project asset next/image's loader
            // can optimise — next/image would require allow-listing every
            // possible tenant's image host in next.config.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt={`${tenantName} logo`} className="h-14 w-auto rounded-lg" />
          ) : (
            <span
              className="flex size-14 items-center justify-center rounded-2xl text-xl font-semibold text-white shadow-sm"
              style={{ backgroundColor: edge }}
              aria-hidden="true"
            >
              {tenantName.trim().charAt(0).toUpperCase() || "·"}
            </span>
          )}
          <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
            {tenantName}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
            {title}
          </h1>
        </header>

        <section
          className="flex flex-col gap-6 rounded-2xl border border-graft-green/15 bg-card p-5 shadow-lg shadow-graft-green/5 sm:p-7"
          style={{ borderTop: `4px solid ${edge}` }}
        >
          {children}
        </section>

        <footer className="mt-auto flex items-center justify-center gap-4 text-xs text-muted-foreground">
          {showBadge ? <PoweredByBadge /> : null}
          <Link href="/privacy" className="hover:text-foreground">
            Privacy
          </Link>
        </footer>
      </main>
    </div>
  );
}
