/**
 * The branded frame around `/login` and `/signup` (and signup's "check your
 * email" step), added in the 2026-08-21 UI refinement.
 *
 * It exists because those pages previously rendered a bare `<Card>` floating
 * in the middle of an empty viewport with no indication of what product the
 * visitor had arrived at — the same gap the landing page had. Centering,
 * lockup, heading and the green accent live here rather than being copied
 * into each page, so the two stay identical as they change.
 *
 * The title is a real `<h1>` (the pages had none — `CardTitle` renders a
 * `<div>`), continuing what GRAFT-20 did for the billing pages.
 */
import Link from "next/link";
import { GraftLockup } from "@/components/brand/graft-logo";
import { Card, CardHeader } from "@/components/ui/card";

export function AuthShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  /** The card body — typically the page's `<form>`, or a confirmation. */
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center px-4 py-12">
      {/* Brand wash behind the card. Purely decorative, and kept faint enough
       * that it never competes with the form's own contrast. */}
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/3 left-1/2 size-72 -translate-x-1/2 rounded-full bg-graft-green/10 blur-3xl"
      />
      <div className="relative flex w-full max-w-sm flex-col gap-6">
        <Link href="/" aria-label="Graft home" className="self-center">
          <GraftLockup className="h-8" />
        </Link>
        <Card className="border-graft-green/30 shadow-md ring-1 ring-graft-green/10">
          <CardHeader className="gap-1.5">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {description ? (
              <p className="text-sm text-muted-foreground">{description}</p>
            ) : null}
          </CardHeader>
          {children}
        </Card>
        {/* An explicit way out. The lockup above also links home, but that is
         * not discoverable as navigation — these pages are otherwise a dead
         * end for anyone who arrived by accident. */}
        <Link
          href="/"
          className="self-center text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          &larr; Back to home
        </Link>
      </div>
    </div>
  );
}
